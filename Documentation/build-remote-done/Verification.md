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

## 2026-10-31 (late) - GitHub CI

Runs 41268363962 (fde833c) and 41268440562 (e83f42a): ubuntu-latest and macos-latest both
enable `ssh localhost` (RD_TEST_SSH=1 exported on every leg, so the 7 ssh integration tests
ran on GNU and BSD userlands). macOS x node 20/22/24/26: PASS. ubuntu x node 20/22/24/26:
FAIL on one test (hook timeout, dash orphan - see Findings). Fix pushed; result below.
Run for 2da0deb (process-group fix): **all 8 legs PASS** (ubuntu-latest + macos-latest x node
20/22/24/26, ssh integration included on every leg). https://github.com/fengryan793/remote-done/actions

## 2026-11-01 - M5 dogfood verification

Environment: ubuntugpu (Ubuntu 24.04, x86_64, Node v24.22.2 user-level), remote-done 0.1.0 installed
from `npm pack` tarball; targets = fresh RunPod community pods (RTX 3070 / RTX A2000), image
runpod/pytorch 2.8.0, ssh over public IP, `--host-key accept-new` (per-run pin).
Driver: `python3 /home/a/n35-run/orchestrate.py --dogfood <scenario>`; logs in
`/home/a/n35-run/dogfood-*.out`, `orchestrate.log`, `remote-done.err`.

| # | scenario | expected | observed | pass |
| --- | --- | --- | --- | --- |
| 1 | ok (2-min job, 7 files in 2 dirs) | done, exit 0, files local, pod terminated | done, 0, 7 files, teardown 477 ms, pod list [] | PASS |
| 2 | abort (SIGTERM at 60 s) | aborted, 143, fetch + teardown still run | aborted, 143, tick.txt, teardown ran | PASS |
| 3 | fail (exit 3) | fail, 1, partial output fetched, teardown (profile pod) | fail (rc=3), 1, partial.json, teardown ran | PASS |
| 4 | stall (`--stall 2m`, silent sleep) | stalled, 5, teardown | stalled at 2m07s, 5, teardown ran | PASS |
| 5 | unreachable (`pkill sshd`, `--unreachable-after 3m`) | unreachable, 3, teardown via API without ssh | reconnect 3->60 s, unreachable 3m00s, fetch refused x5, teardown ran, 3 | PASS |
| 6 | fetchfail (glob matches nothing) | done, 4, force teardown after 5 min | 5 min of fetch rounds, warn, teardown ran, 4 | PASS |

Also verified: `npm pack` contents; `--dry-run` of the run-mode and the resume-mode commands;
notify hook env (RD_STATUS/RD_SIGNAL/RD_ERROR/RD_FETCH_OK...); `--terminate` of a bogus pod exits 1;
state file `~/.cache/remote-done/<id>.json` with adopted pid and `finished`; RunPod pod list empty
after every run. Unit suite after the `wait` alias: 61 passed, 7 skipped (ssh opt-in), tsc clean.

Not verified live: the full native-35 `main()` loop on an H100 (the batch is finished: 2 clips left,
below the 50-clip threshold, so `main()` exits at once), the in-run periodic sync and balance branch
of `monitor()` (SYNC_S = 600 s never reached in a 2-6 min run; the SIGTERM path it uses is run 2),
resume mode live, a changed host key on a real pod, ntfy/webhook notifiers.

## 2026-11-01 repo visibility

- API returned private=false visibility=public; anonymous GET of the repo page returned the status code logged above.
