# Progress - Build `remote-done`

## 2026-10-31

- Ryan confirmed the three Plan v2.1 decisions: standalone package `remote-done`; Node >= 20
  with CI on 20/22/24/26; defaults = onUnreachable/onAbort notify-only + `--profile pod`,
  teardown gated on a successful fetch, host-key `accept-new` with fast-fail on a changed key.
- M0: scaffolded `~/Documents/remote-done` from the comfy-resolve conventions (ESM, tsup,
  vitest, strict tsconfig, MIT). CI matrix ubuntu-latest + macos-latest x node 20/22/24/26 with
  an "Enable ssh localhost" step that exports `RD_TEST_SSH=1` (hard requirement on Linux, soft
  on macOS) and a built-CLI smoke step.
- M0.5: `src/types.ts` (status enum, exit codes, Spec/Result, Transport contract, error
  classes) and `Design.md` (decision table).
- M1: `src/conditions.ts` (log/exitFile/process/port/http/file/command/all/any),
  `src/tail.ts` (byte-offset tailer with carry, rotation, bounded window), `src/engine.ts`
  (poll loop with precedence, reconnect/backoff, stall freeze, terminal pipeline, dead-man,
  state file), `src/hooks.ts`, `src/notify.ts`, `src/state.ts`.
- M2: `src/transport/{base,local,ssh}.ts` + `src/recipes.ts` (GNU/BSD stat dialect, sentinel,
  classification, scp/rsync fetch), `src/run.ts` (detached start with the idempotency probe).
- M3: `src/cli.ts` (parseArgs with `multiple`, `--profile pod`, NDJSON, signals, caffeinate).
- Tests: 61 local tests across 6 files (duration/shell, tail, recipes+classification,
  conditions, engine with FakeTransport + virtual clock, CLI parse + end-to-end on dist/cli.js)
  and 7 ssh integration tests (`RD_TEST_SSH=1`, host overridable with `RD_TEST_SSH_HOST`).
- Fixed during the first run: `run` mode wrongly required `--done`; `all` must treat
  "every other child done + process exited" as done; two tests had wrong expectations
  (default tail-from-end, documented copytruncate limit).

## 2026-11-01 - M5 dogfood

- Read orchestrate.py (261 lines) and the state on ubuntugpu: batch done, 2 leftover clips, no node.
- Installing Node v24.22.2 user-level on ubuntugpu (~/.local/node, symlinks in ~/.local/bin).
- `npm pack` of remote-done 0.1.0 into the scratchpad for the install on ubuntugpu.
- remote-done 0.1.0 installed on ubuntugpu from the tarball (`~/.local/bin/remote-done`, `--version` ok).
- orchestrate.py rewritten (backup `orchestrate.py.bak-2026-11-01` on both machines): `rd_command()`,
  `monitor()` (NDJSON reader thread + periodic sync + balance gate -> SIGTERM), `--terminate`,
  `--notify`, `--dogfood [--abort-after SEC]`, `wait_ssh()`, `n35_job()` replacing `start_run()`.
- `--dry-run` of both the run-mode and the resume-mode command verified on ubuntugpu; the only
  wrapper bug was `remote-done wait` (no such subcommand), fixed.
- Started dogfood run 1 (happy path) on ubuntugpu: `python3 orchestrate.py --dogfood`, output in
  `/home/a/n35-run/dogfood-run1.out` and orchestrate.log.
- Run 1 (happy path) passed, see Findings. Added `--dogfood abort|fail|stall` scenarios and started
  them back to back on ubuntugpu (each grabs its own cheapest pod).
- remote-done: `wait` accepted as an alias of the default mode (src/cli.ts + test in test/cli.test.ts).
- Runs 2-4 (abort / fail / stall) passed. Added scenario `unreachable` (the job runs `pkill -x sshd`
  30 s in; `--unreachable-after 3m`) and started it.
- Run 5 (unreachable) passed. Added scenario `fetchfail` (job ok, fetch glob matches nothing ->
  exit 4 and `--force-teardown-after 5` must still terminate) and started it.
- Run 6 (fetchfail) passed. Fixed README exit-code row 4 and the `--help` line (teardown skipped
  *unless forced*). CHANGELOG notes the `wait` alias and the dogfood. Suite 61/61, tsc clean.
- Wrote the M5 acceptance table (Findings) and Verification section.

## 2026-11-01 repo made public

- Ryan asked to flip https://github.com/fengryan793/remote-done to public; done with REST PATCH {"private":false} using the github_ryan PAT (gh CLI is logged in as heroku514, and the github_ryan MCP has no update-repo tool). History secret scan was clean first.
