# claw-code setup notes (CRM-233)

[ultraworkers/claw-code](https://github.com/ultraworkers/claw-code) is a Rust
implementation of the `claw` CLI agent harness (a Claude Code–style agent).
This note records how it was installed, run, and verified in the CRM-233
remote session on 2026-08-16, plus one environment gotcha worth knowing.
`scripts/setup-claw-code.sh` automates the same steps.

## Install

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/ultraworkers/claw-code
cd claw-code
./install.sh          # runs `cargo build --workspace` and smoke-tests the binary
```

- Toolchain used: rustc/cargo 1.94.1; the workspace builds 11 crates
  (~354 locked dependencies). Debug build completed cleanly, exit 0.
- Binary lands at `rust/target/debug/claw` (v0.1.3).
- The installer itself verifies `claw --version` and `claw --help`.

## Run

Verified working in this session:

- `claw --version` / `claw version` — reports version, git SHA, target triple.
- `claw doctor` — 10 OK, 2 warnings, 0 failures. The warnings are expected
  here: no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is present in the
  session, so auth is unset. Real prompting needs one of those set.
- End-to-end agent runs without credentials, using the repo's own mock
  Anthropic service:

  ```bash
  # terminal 1 — deterministic mock of /v1/messages
  rust/target/debug/mock-anthropic-service --bind 127.0.0.1:41799
  # prints MOCK_ANTHROPIC_BASE_URL=http://127.0.0.1:41799

  # terminal 2 — point claw at it (any non-empty key works)
  ANTHROPIC_BASE_URL=http://127.0.0.1:41799 ANTHROPIC_API_KEY=mock \
    rust/target/debug/claw prompt "PARITY_SCENARIO:streaming_text hello"
  ```

  Confirmed: streamed text response; a full `read_file` tool round-trip
  (model requests the tool, claw executes it locally, model sees the result);
  and the `bash` tool including claw's own permission prompt
  (workspace-write → danger-full-access escalation requires approval).

## Environment gotcha: profile noise breaks exact-stdout tests

The upstream mock parity suite (`rust/scripts/run_mock_parity_harness.sh`,
12 scripted scenarios) passed scenarios 1–6 in this container, then failed at
`bash_stdout_roundtrip`:

```
assertion `left == right` failed
  left: String("nvm\nalpha from bash")
 right: String("alpha from bash")
```

Root cause is the container, not claw-code. claw's bash tool executes
commands with `sh -lc`; `/bin/sh` here is dash, and a dash *login* shell
sources `/etc/profile.d/*.sh`. This image's `/etc/profile.d/nvm.sh` prints a
stray `nvm` line under dash (nvm only supports bash/zsh), which leaks into
every bash-tool stdout. Reproducible with no claw involvement:

```bash
env -i PATH=/usr/bin:/bin HOME=/tmp/nohome sh -lc "printf 'alpha from bash'"
# → nvm
# → alpha from bash
```

Implications:

- Only the two scenarios that execute the bash tool and assert exact stdout
  are affected; functionality is unimpaired.
- On machines whose login-shell profiles are silent (typical dev laptops,
  upstream CI), the suite should pass as-is.
- Fix options if the suite must be green in such a container: make
  `/etc/profile.d/nvm.sh` a no-op for non-bash shells (guard it with
  `[ -n "${BASH_VERSION-}" ]`), or remove it from the image.
