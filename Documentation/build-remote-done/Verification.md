# Verification - Build `remote-done`

## 2026-10-31

| check | command | result |
| --- | --- | --- |
| typecheck | `npx tsc --noEmit` | PASS |
| unit + e2e | `npx vitest run` | PASS 61/61 (7 ssh tests skipped without RD_TEST_SSH) |
| ssh integration (Linux remote) | `RD_TEST_SSH=1 RD_TEST_SSH_HOST=ubuntugpu npx vitest run test/ssh.test.ts` | PASS 7/7 in 31 s |
| build | `npx tsup` (via vitest globalSetup) | PASS, dist/cli.js 81 KB, dist/index.js 65 KB |
| CLI smoke, human mode | local log + `--on-done` + `--teardown` | done in 3 s, hooks saw RD_STATUS/RD_MATCH, exit 0 |
| CLI smoke, `--json` fail | log containing Traceback, `--fail Traceback --from-start` | NDJSON start/poll/matched/result, exit 1 |

Covered by tests: straddled marker, UTF-8 split, rotation + truncation, `echo -n DONE`,
over-long partial line; exit codes 0/1/2/3/4/5/6/7/8/64/130/143; teardown gating incl. empty
fetch glob, forceTeardown, `--profile pod` on timeout; reconnect backoff 3/6/12 s with frozen
stall clock; unreachable budget; host key fast-fail; abort via AbortSignal and real SIGTERM on
the built CLI; hook stdin EOF, env, ctx file, timeout; function hooks; `watch()`; dead-man
arm/disarm; `run` happy path, rc != 0 and early `--fail` marker; ssh sentinel, stat/tail dialect,
pgrep self-exclusion, listGlob/totalBytes, scp fetch, run + wait over ssh.

Not yet verified: CI on GitHub (first push pending), Node 22/24/26 locally (only 20.20.2 here),
`--host-key` changed-key path against a real changed server key (classification is unit-tested
on captured stderr only), rsync fetch end-to-end (scp path only), ntfy/webhook notifiers (no
network test), `--deadman` on a remote host, long runs (hours) with real network drops.
