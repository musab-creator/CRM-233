"""deploy/update.sh: pull the tracked branch fast-forward only, reinstall, restart; refuse
anything else when run through the deploy key's forced command."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "update.sh"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"}

pytestmark = pytest.mark.skipif(shutil.which("git") is None or shutil.which("bash") is None,
                                reason="needs git and bash")


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_ENV}).stdout.strip()


@pytest.fixture
def server(tmp_path, request):
    """A bare 'origin', a server clone on branch work with the update script, and a developer
    clone that pushes a new commit. Stubs for sudo, systemctl and install.sh log what ran."""
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "work", str(origin))
    dev = tmp_path / "dev"
    git(tmp_path, "clone", "-q", str(origin), str(dev))
    git(dev, "checkout", "-q", "-b", "work")
    prefix = getattr(request, "param", "")
    if prefix:
        dev = dev / prefix
        dev.mkdir()
    (dev / "deploy").mkdir()
    shutil.copy(SCRIPT, dev / "deploy" / "update.sh")
    (dev / "deploy" / "install.sh").write_text(
        '#!/usr/bin/env bash\n'
        'echo install >> "$UPDATE_LOG"\n'
        '[ "${FAIL_INSTALL:-0}" != 1 ] || exit 42\n'
        'mkdir -p "$MEME_AGENTS_VENV_DIR/bin"\n'
        'if [ "${EDIT_RUNNING_SOURCE:-0}" = 1 ]; then echo "operator edit" > "${UPDATE_LOG%/*}/v"; fi\n'
        "printf '#!/usr/bin/env bash\\necho \"OK: stub status\"\\nexit \"${FAIL_STATUS:-0}\"\\n' > \"$MEME_AGENTS_VENV_DIR/bin/python\"\n"
        'chmod +x "$MEME_AGENTS_VENV_DIR/bin/python"\n')
    (dev / "deploy" / "install.sh").chmod(0o755)
    (dev / "deploy" / "update.sh").chmod(0o755)
    (dev / "v").write_text("1\n")
    git(dev, "add", "-A")
    git(dev, "commit", "-q", "-m", "one")
    git(dev, "push", "-q", "-u", "origin", "work")
    srv = tmp_path / "srv"
    git(tmp_path, "clone", "-q", "-b", "work", str(origin), str(srv))
    if prefix:
        srv = srv / prefix
    (srv / ".venv" / "bin").mkdir(parents=True)
    (srv / ".venv" / "bin" / "python").write_text("#!/usr/bin/env bash\necho 'OK: stub status'\n")
    (srv / ".venv" / "bin" / "python").chmod(0o755)
    stubs = tmp_path / "bin"
    stubs.mkdir()
    (stubs / "sudo").write_text('#!/usr/bin/env bash\necho "sudo $*" >> "$UPDATE_LOG"\n'
                                'while [ "${1:-}" = -n ]; do shift; done\n"$@"\n')
    (stubs / "systemctl").write_text('#!/usr/bin/env bash\necho "systemctl $*" >> "$UPDATE_LOG"\n'
                                     '[ "$1" != restart ] || [ "${FAIL_RESTART:-0}" != 1 ] || exit 1\n'
                                     '[ "$1" != is-active ] || [ "${SERVICE_INACTIVE:-0}" != 1 ] || exit 3\n'
                                     'exit 0\n')
    (stubs / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
    for f in stubs.iterdir():
        f.chmod(0o755)
    (dev / "v").write_text("2\n")
    git(dev, "commit", "-q", "-am", "two")
    git(dev, "push", "-q", "origin", "work")
    new_sha = git(dev, "rev-parse", "HEAD")
    return srv, dev, stubs, new_sha


def run(srv, stubs, *args, ssh_cmd=None, extra_env=None):
    env = {**os.environ, **GIT_ENV, "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}", "UPDATE_LOG": str(srv / "log")}
    env.update(extra_env or {})
    if ssh_cmd is not None:
        env["SSH_ORIGINAL_COMMAND"] = ssh_cmd
    else:
        env.pop("SSH_ORIGINAL_COMMAND", None)
    return subprocess.run(["bash", str(srv / "deploy" / "update.sh"), *args], cwd=srv, capture_output=True, text=True,
                          env=env)


def test_forced_command_pulls_reinstalls_and_restarts(server):
    srv, dev, stubs, new_sha = server
    r = run(srv, stubs, ssh_cmd=f"deploy work {new_sha}")
    assert r.returncode == 0, r.stderr
    assert git(srv, "rev-parse", "HEAD") == new_sha and (srv / "v").read_text() == "2\n"
    log = (srv / "log").read_text().splitlines()
    assert log == ["install", "systemctl is-active --quiet meme-agents",
                   "sudo -n systemctl stop meme-agents", "systemctl stop meme-agents",
                   "sudo -n systemctl restart meme-agents", "systemctl restart meme-agents",
                   "systemctl is-active --quiet meme-agents"]
    assert "updating work" in r.stdout and "two" in r.stdout and "OK: stub status" in r.stdout
    assert r.stdout.rstrip().endswith(f"deployed {new_sha[:12]}")
    # nothing new: no reinstall, no restart
    r = run(srv, stubs, ssh_cmd=f"deploy work {new_sha}")
    assert r.returncode == 0 and "nothing to do" in r.stdout and len((srv / "log").read_text().splitlines()) == 7


def test_other_branch_bad_command_and_force(server):
    srv, dev, stubs, new_sha = server
    r = run(srv, stubs, ssh_cmd=f"deploy main {new_sha}")
    assert r.returncode == 0 and "server tracks work; the push was to main: nothing to deploy" in r.stdout
    assert git(srv, "rev-parse", "HEAD") != new_sha and not (srv / "log").exists()
    for bad in ("bash", "deploy work; rm -rf /", "deploy work", f"deploy 'w' {new_sha}"):
        r = run(srv, stubs, ssh_cmd=bad)
        assert r.returncode == 2 and "refused" in r.stderr, bad
    assert not (srv / "log").exists()
    # by hand, without the forced command: --force reinstalls and restarts even when up to date
    r = run(srv, stubs)
    assert r.returncode == 0 and git(srv, "rev-parse", "HEAD") == new_sha
    r = run(srv, stubs, "--force")
    assert r.returncode == 0 and "nothing to do" not in r.stdout
    assert (srv / "log").read_text().count("install") == 2
    assert "sudo systemctl restart meme-agents" in (srv / "log").read_text()   # by hand: sudo may prompt
    assert run(srv, stubs, "--bogus").returncode == 2


def test_local_changes_are_never_overwritten(server):
    srv, dev, stubs, new_sha = server
    (srv / "v").write_text("local edit\n")
    git(srv, "commit", "-q", "-am", "local")
    r = run(srv, stubs, ssh_cmd=f"deploy work {new_sha}")
    assert r.returncode != 0 and not (srv / "log").exists()
    assert (srv / "v").read_text() == "local edit\n"


def test_the_ops_service_never_waits_for_a_sudo_password(server):
    srv, _dev, stubs, new_sha = server
    r = run(srv, stubs, extra_env={"MEME_AGENTS_NONINTERACTIVE": "1"})
    assert r.returncode == 0, r.stderr
    assert git(srv, "rev-parse", "HEAD") == new_sha
    log = (srv / "log").read_text()
    assert "sudo -n systemctl stop meme-agents" in log and "sudo -n systemctl restart meme-agents" in log
    assert "sudo systemctl" not in log


def test_the_ops_service_rollback_never_waits_for_a_sudo_password_either(server):
    srv, _dev, stubs, new_sha = server
    old_sha = git(srv, "rev-parse", "HEAD")
    r = run(srv, stubs, extra_env={"MEME_AGENTS_NONINTERACTIVE": "1", "FAIL_RESTART": "1"})
    assert r.returncode != 0 and "deployment failed" in r.stderr
    assert git(srv, "rev-parse", "HEAD") == old_sha and (srv / "v").read_text() == "1\n"
    assert (srv / ".venv" / "bin" / "python").exists() and not list(srv.glob(".venv-deploy.*"))
    log = (srv / "log").read_text()
    assert "sudo -n systemctl restart meme-agents" in log and "sudo -n systemctl start meme-agents" in log
    assert "sudo systemctl" not in log
