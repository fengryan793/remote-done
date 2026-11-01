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
