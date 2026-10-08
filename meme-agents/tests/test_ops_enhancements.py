"""Operational failures must not leak secrets, destroy state or report a false deployment."""
import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

import pytest

from bot import __main__ as cli
from bot import util
from bot.config import load_dotenv
from tests.test_update_script import git, run, server  # noqa: F401; shared local-only Git fixture

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def isolated_redaction(monkeypatch):
    monkeypatch.setattr(util, "_KNOWN_SECRETS", set())


@pytest.mark.parametrize("text,secret", [
    ("?API-Key=tiny&method=x", "tiny"),
    ("{'x-api-key': 'sk-ant-12345'}", "sk-ant-12345"),
    ('{"HELIUS_API_KEY":"abcd"}', "abcd"),
    ("Authorization: bearer secret-token", "secret-token"),
    ("Authorization: Basic c2VjcmV0", "c2VjcmV0"),
    ("https://api.telegram.org/bot123:abc_DEF/sendMessage", "123:abc_DEF"),
    ("WALLET_PRIVATE_KEY=[1, 2, 3, 4]", "[1, 2, 3, 4]"),
])
def test_redact_provider_headers_json_and_short_keys(text, secret):
    result = util.redact(text)
    assert secret not in result and "***" in result


def test_configured_secret_is_redacted_in_unlabelled_errors_and_tracebacks():
    secret = "secret/key+with spaces"
    util.register_secrets([secret])
    assert secret not in util.redact(f"provider echoed {secret}")
    assert "secret%2Fkey%2Bwith%20spaces" not in util.redact("failed: secret%2Fkey%2Bwith%20spaces")
    assert "secret%2Fkey%2Bwith+spaces" not in util.redact("failed: secret%2Fkey%2Bwith+spaces")
    try:
        raise RuntimeError(secret)
    except RuntimeError:
        import sys
        record = logging.LogRecord("test", logging.ERROR, __file__, 1, "provider failed", (), sys.exc_info())
        formatted = util.RedactingFormatter().format(record)
    assert secret not in formatted and "RuntimeError: ***" in formatted


def test_redaction_preserves_the_database_path():
    assert util.redact("database is /home/bot/project/data/bot.db") == "database is /home/bot/project/data/bot.db"


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "-inf", "abc"])
@pytest.mark.parametrize("command", ["run", "simulate", "acceptance"])
def test_cli_rejects_invalid_durations_without_starting(command, value, capsys):
    with pytest.raises(SystemExit) as error:
        cli.main([command, "--minutes", value])
    assert error.value.code == 2
    assert "greater than zero" in capsys.readouterr().err or value == "-inf"


@pytest.mark.parametrize("day", ["2026-02-30", "20261006", "yesterday"])
def test_report_rejects_invalid_day(day, capsys):
    with pytest.raises(SystemExit) as error:
        cli.main(["report", "--day", day])
    assert error.value.code == 2 and "YYYY-MM-DD" in capsys.readouterr().err


def test_status_alert_requires_check(capsys):
    with pytest.raises(SystemExit) as error:
        cli.main(["status", "--alert"])
    assert error.value.code == 2 and "--alert requires --check" in capsys.readouterr().err


def test_cli_file_failure_is_actionable_and_redacted(s, monkeypatch, capsys):
    s.ANTHROPIC_API_KEY = "private-configured-key"
    monkeypatch.setattr(cli, "load_settings", lambda **_: s)
    monkeypatch.setattr(cli, "setup_logging", lambda *_: None)

    async def failed(_):
        raise PermissionError("denied private-configured-key")
    monkeypatch.setattr(cli, "_run", failed)
    assert cli.main(["run", "--minutes", "1"]) == 3
    error = capsys.readouterr().err
    assert "permissions" in error and "private-configured-key" not in error


def test_acceptance_no_llm_clears_configured_key(monkeypatch, s):
    import bot.acceptance
    observed = {}

    def settings(**kwargs):
        observed.update(kwargs)
        s.ANTHROPIC_API_KEY = "" if kwargs.get("overrides", {}).get("ANTHROPIC_API_KEY") == "" else "would-spend"
        return s

    async def acceptance(settings, *_args, **_kwargs):
        assert settings.ANTHROPIC_API_KEY == ""
        return 3

    monkeypatch.setattr(cli, "load_settings", settings)
    monkeypatch.setattr(bot.acceptance, "run_acceptance", acceptance)
    assert asyncio.run(cli._acceptance(1, False, 7, True)) == 3
    assert observed["overrides"] == {"ANTHROPIC_API_KEY": ""}


@pytest.mark.parametrize("rate", [0, -1, float("nan"), float("inf")])
def test_rate_limiter_refuses_unusable_rates(rate):
    with pytest.raises(ValueError, match="rate_per_s"):
        util.RateLimiter(rate)


def test_fractional_rate_with_fractional_burst_can_issue_a_request():
    async def go():
        limiter = util.RateLimiter(0.25, burst=0.25)
        await asyncio.wait_for(limiter.acquire(), 0.1)
        assert limiter.tokens == 0
    asyncio.run(go())


def test_backoff_survives_prolonged_outages(monkeypatch):
    monkeypatch.setattr(util.random, "uniform", lambda _low, high: high)
    assert util.backoff_delay(10_000) == 60
    assert util.backoff_delay(0) == 1
    assert util.backoff_delay(4) == 16


def test_update_failure_during_staging_keeps_running_version(server):
    srv, _dev, stubs, sha = server
    original = git(srv, "rev-parse", "HEAD")
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}", extra_env={"FAIL_INSTALL": "1"})
    assert result.returncode != 0 and "deployed " not in result.stdout
    assert git(srv, "rev-parse", "HEAD") == original
    assert not (srv / ".venv").is_symlink()
    assert (srv / "log").read_text().splitlines() == ["install"]
    assert not list(srv.glob(".venv-deploy.*"))


def test_update_preserves_operator_edit_made_during_validation(server):
    srv, _dev, stubs, sha = server
    original = git(srv, "rev-parse", "HEAD")
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}", extra_env={"EDIT_RUNNING_SOURCE": "1"})
    assert result.returncode != 0 and "local edits appeared" in result.stderr
    assert git(srv, "rev-parse", "HEAD") == original and (srv / "v").read_text() == "operator edit\n"
    assert "systemctl stop" not in (srv / "log").read_text()


@pytest.mark.parametrize("failure", ["FAIL_RESTART", "FAIL_STATUS"])
def test_update_failure_after_promotion_restores_code_dependencies_and_state(server, failure):
    srv, _dev, stubs, sha = server
    original = git(srv, "rev-parse", "HEAD")
    (srv / "data").mkdir()
    states = {".env": "MODE=paper\n", "STOP": "", "data/bot.db": "persistent bankroll"}
    for name, content in states.items():
        (srv / name).write_text(content)
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}", extra_env={failure: "1"})
    assert result.returncode != 0 and "deployed " not in result.stdout
    assert "restoring the previous" in result.stderr
    assert git(srv, "rev-parse", "HEAD") == original and (srv / "v").read_text() == "1\n"
    assert not (srv / ".venv").is_symlink()
    assert "systemctl start meme-agents" in (srv / "log").read_text()
    for name, content in states.items():
        assert (srv / name).read_text() == content


def test_update_success_preserves_runtime_state_and_keeps_stopped_service_stopped(server):
    srv, _dev, stubs, sha = server
    (srv / "data").mkdir()
    states = {".env": "MODE=paper\n", "STOP": "", "data/bot.db": "persistent bankroll"}
    for name, content in states.items():
        (srv / name).write_text(content)
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}", extra_env={"SERVICE_INACTIVE": "1"})
    assert result.returncode == 0, result.stderr
    assert git(srv, "rev-parse", "HEAD") == sha
    assert "left stopped" in result.stdout and "sudo" not in (srv / "log").read_text()
    assert (srv / ".venv" / "bin" / "python").exists()
    for name, content in states.items():
        assert (srv / name).read_text() == content


def test_update_rejects_tracked_runtime_file_from_remote(server):
    srv, dev, stubs, _sha = server
    original = git(srv, "rev-parse", "HEAD")
    (dev / ".env").write_text("MODE=live\n")
    git(dev, "add", ".env")
    git(dev, "commit", "-q", "-m", "bad tracked state")
    git(dev, "push", "-q", "origin", "work")
    sha = git(dev, "rev-parse", "HEAD")
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}")
    assert result.returncode != 0 and "protected runtime file" in result.stderr
    assert git(srv, "rev-parse", "HEAD") == original and not (srv / "log").exists()


@pytest.mark.parametrize("server", ["meme-agents"], indirect=True)
def test_update_supports_project_inside_a_larger_repository(server):
    srv, _dev, stubs, sha = server
    result = run(srv, stubs, ssh_cmd=f"deploy work {sha}")
    assert result.returncode == 0, result.stderr
    assert git(srv, "rev-parse", "HEAD") == sha and (srv / ".venv/bin/python").exists()


@pytest.mark.parametrize("server", ["meme-agents"], indirect=True)
def test_update_protects_nested_project_state(server):
    test_update_rejects_tracked_runtime_file_from_remote(server)


def _setter(tmp_path, values, content):
    (tmp_path / "deploy").mkdir()
    shutil.copy(ROOT / "deploy" / "set-env.sh", tmp_path / "deploy" / "set-env.sh")
    file = tmp_path / ".env"
    file.write_text(content)
    result = subprocess.run(["bash", str(tmp_path / "deploy" / "set-env.sh"), *values],
                            capture_output=True, text=True)
    return result, file


def test_set_env_updates_duplicates_in_place_without_printing_values(tmp_path):
    (tmp_path / ".env").write_text("x")
    inode = (tmp_path / ".env").stat().st_ino
    result, file = _setter(tmp_path, ["LIVE_DRY_RUN=true", "ANTHROPIC_API_KEY=private-new-value"],
                           "LIVE_DRY_RUN=false # explanation\nLIVE_DRY_RUN=false\nANTHROPIC_API_KEY=old\n")
    assert result.returncode == 0, result.stderr
    assert file.stat().st_ino == inode             # the bot's read-only bind mount sits on this inode
    parsed = load_dotenv(file)
    assert parsed["LIVE_DRY_RUN"] == "true" and parsed["ANTHROPIC_API_KEY"] == "private-new-value"
    assert file.read_text().count("LIVE_DRY_RUN=") == 1
    assert "# explanation" in file.read_text()
    assert "private-new-value" not in result.stdout + result.stderr
    assert file.stat().st_mode & 0o777 == 0o600
    assert not list(tmp_path.glob(".env-update-*"))


@pytest.mark.parametrize("argument", ["bad=private-value", "MODE=paper\nMODE=live"])
def test_set_env_refuses_invalid_input_without_changing_file_or_echoing_it(tmp_path, argument):
    original = "MODE=paper\n"
    result, file = _setter(tmp_path, [argument], original)
    assert result.returncode != 0 and file.read_text() == original
    assert "private-value" not in result.stdout + result.stderr


def test_service_allows_stop_file_with_protected_code_and_credentials():
    app = "/home/bot/project"
    unit = (ROOT / "deploy" / "meme-agents.service").read_text().replace("@APP_DIR@", app).replace("@USER@", "bot")
    assert f"ReadWritePaths={app}\n" in unit
    assert f"ReadOnlyPaths={app}/bot {app}/deploy {app}/.env {app}/.venv" in unit
    assert "RestartPreventExitStatus=2" in unit and "unclean crash/watchdog restart" in unit


def test_ci_runs_tests_without_vps_credentials():
    """ci.yml tests meme-agents on every push with no secrets; the deploy workflow only
    reaches a server (and only re-runs the tests) once the VPS_* secrets exist."""
    workflows = ROOT.parent / ".github" / "workflows"
    ci = (workflows / "ci.yml").read_text()
    ci_job = ci.split("Test meme-agents", 1)[1].split("\n  xtract:", 1)[0]
    assert "python -m pytest -q" in ci_job and "secrets." not in ci_job
    deploy = (workflows / "meme-agents-deploy.yml").read_text()
    ssh_step = deploy.split("Update the server over SSH", 1)[1]
    assert "if: steps.cfg.outputs.ok == 'true'" in ssh_step
    assert "trap 'rm -f ~/.ssh/deploy_key' EXIT" in ssh_step and "unsupported branch name" in ssh_step
