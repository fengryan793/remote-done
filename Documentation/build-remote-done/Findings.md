# Findings - Build `remote-done`

## 2026-10-31

- `pgrep -f PATTERN` inside `$( ... )` matches the forked subshell, whose cmdline still carries
  the pattern, so `[ -n "$(pgrep ...)" ]` reports a dead process as alive. Using a plain
  pipeline `pgrep -f -- PAT | grep -vqx -e $$ -e $PPID` avoids the subshell and excludes the
  probe's own shell and its parent (the ssh login shell, or node locally).
- The local Mac has Remote Login on but no key for `a@localhost`, so the ssh integration tests
  were run against `ubuntugpu` (Linux, GNU userland) instead; macOS/BSD recipes are covered by
  the local unit tests on this Mac and by the macos-latest CI leg.
- macOS 26 ships `openrsync` (protocol 29): `rsync -s/--protect-args` is not portable, so fetch
  passes remote paths unquoted and documents "no spaces in remote paths" for 0.1.
- A copytruncate rotation that regrows past the old offset on the same inode between two
  polls is indistinguishable from an append (Plan v2.1 limit) - the test now encodes exactly
  that behaviour instead of pretending it is detected.
- Run ids are UTC timestamps (`20261101-031245-xxxx` at 20:12 PDT); harmless but worth knowing
  when reading `~/.cache/remote-done/`.
- First CI run: all macOS legs green (ssh localhost works on macos-latest, so the integration
  tests ran there too) and every ubuntu leg failed exactly one test, "hook timeout kills the
  hook": `/bin/sh` is dash on Ubuntu and dash does not exec the last command of `sh -c`, so
  killing `sh` leaves the `sleep` orphan holding our stdout/stderr pipes until it ends (30 s).
  Fix: hooks and local commands run `detached` in their own process group, the group is killed
  on timeout, and a 1 s grace after `exit` stops any grandchild from blocking us.

## 2026-11-01 - M5 dogfood findings (running log)

- **No live run to attach to.** native-35 finished 2026-10-31 (90719 JSONs on ubuntugpu, 2 clips left,
  "not worth a new pod"). The dogfood therefore uses `orchestrate.py --dogfood`: same code path
  (grab -> wait ssh -> `remote-done run --profile pod` -> fetch -> teardown hook) on the cheapest
  community GPU (RTX A2000 $0.12/h, RTX 3070 $0.13/h ... per the gpuTypes query) with a synthetic
  2-minute job writing `/workspace/out/film-a/clip-N.json`.
- **ubuntugpu had no Node.** Installed v24.22.2 user-level (`~/.local/node`, symlinks in
  `~/.local/bin`; sha256 verified against SHASUMS256.txt). Non-interactive ssh shells do not source
  `.bashrc` (early `return`), so the wrapper calls `~/.local/bin/remote-done` by absolute path and
  prepends `~/.local/bin` to PATH for the `#!/usr/bin/env node` shebang.
- **`npm pack` contents are right** (LICENSE, README, dist/{cli.js,index.js,index.d.ts,maps},
  package.json; 142 kB). `npm i -g remote-done-0.1.0.tgz` on ubuntugpu worked first time; the bin
  lands in `~/.local/node/bin`, symlinked into `~/.local/bin`.
- **No free pod stand-in on ubuntugpu**: it cannot ssh to itself (own key not in authorized_keys,
  left untouched) and has no docker. Hence a real pod for the dogfood.
- **CLI paper cut: there is no `wait` subcommand.** Wait mode is the bare command; `remote-done wait ...`
  exits 64 with `unexpected argument "wait"`. My first wrapper assumed `run`/`wait` symmetry. Worth
  accepting `wait` as an alias in 0.1.1 (one line in parseCli) because that is what people will type.
- **`--dry-run` in run mode shows `until: exitFile LOG.rc` only** - the pid condition is only known
  after the start, so the printed spec under-describes the real probe (process + exit file). Cosmetic.
- Hooks via the wrapper work: `--notify` -> `orchestrate.py --notify` logs the RD_* context;
  `--terminate bogus` returns exit 1 with `pod not found to terminate` (so a failed teardown becomes
  remote-done exit 8 instead of a silent success).
- **Dogfood run 1 (happy path) PASSED on a real RunPod pod** (RTX 3070 community, $0.13/h; the
  A2000 had no stock). Timeline: grab 17:06:30 -> ssh up 17:06:52 -> `remote-done run` 17:07:02 ->
  `matched rc=0` 17:09:13 -> rsync fetch ok 17:09:15 (2 entries = the `film-a`/`film-b` dirs,
  7 files locally) -> teardown hook `--terminate` exit 0 in 477 ms -> notify hook -> result `done`,
  exit 0. Total 166 s, about $0.006. State file `~/.cache/remote-done/<id>.json` records the
  adopted pid (548) and `finished: done/0`; per-run known_hosts pin created under
  `~/.local/state/remote-done/known_hosts.d/`. RunPod pod list empty afterwards.
- `RD_FETCHED` / `fetched` count **glob entries, not files**: `/workspace/out/*` matched two
  directories which rsync copied recursively. Correct, but a user reading "fetched 2" may expect
  file counts; document in README ("entries the glob matched").
- **Dogfood runs 2-4 PASSED on real pods** (RTX 3070 / RTX A2000 community, $0.12-0.13/h):

  | scenario | job | remote-done result | fetched | teardown | elapsed |
  | --- | --- | --- | --- | --- | --- |
  | abort | ticks every 10 s; wrapper sends SIGTERM at 60 s | `aborted`, exit 143, RD_SIGNAL=SIGTERM | tick.txt | ran, pod gone | 100 s |
  | fail | writes partial.json, exits 3 after 20 s | `fail` (matched `rc=3`), exit 1 | partial.json | ran (profile pod) | 99 s |
  | stall | writes one line, then `sleep 900` silently; `--stall 2m` | `stalled` after 2m07s, exit 5 | before-stall.json | ran | 167 s |

  Every path fetched first, then terminated the pod through the hook; pod list empty afterwards.
  The SIGTERM path printed `SIGTERM received, stopping (onAbort hooks run; press again to exit at
  once)` on stderr and still completed fetch + teardown before exiting.
- Stall precision: `--stall 2m` with `--interval 15s` fired at 2m07s - within one poll, as designed.
- `fail` without any `--fail` regex: the rc file alone was enough (`matched: rc=3`). The
  `Traceback` on stderr went to the run log, as expected.
- Wrapper-only artifact, not a remote-done bug: the hook-output column in orchestrate.log showed
  `OTIFY aborted ...` because the wrapper keeps the last 200 chars of the hook output.
- **Dogfood run 5 (unreachable) PASSED - the case that matters most for billing.** The job ran
  `pkill -x sshd` 30 s in. remote-done saw `Connection refused`, backed off 3/6/12/24/48/60/60 s,
  declared `unreachable for 3m00s` (`--unreachable-after 3m`), tried the fetch 5 times (about 30 s,
  all refused), then ran the teardown hook anyway: the RunPod API call does not need ssh, so the pod
  was terminated. Result `unreachable`, exit 3, `fetchOk false`, `teardownRan true`; notify ran, no
  `--on-fail` (notify-only status, as designed). 287 s in total.
- Observed semantics worth stating in the README: `--force-teardown-after` only delays teardown for
  a **done** job whose fetch failed. For `unreachable` / `stalled` / `fail` / `aborted` under
  `--profile pod`, teardown follows right after the per-entry fetch retries (5 tries, ~30 s). That
  matches the old Python (10 min dead -> one sync attempt -> terminate) and is the right call for an
  hourly-billed pod, but a user could expect the 5-minute grace there too.
- **Dogfood run 6 (fetchfail) PASSED.** Job exited 0, the fetch glob `/workspace/nothing-here/*`
  matched nothing. remote-done retried the fetch in rounds (5 tries each, then 30 s pause) for
  5 min, emitted `fetch still failing after 5 min; tearing down anyway (--force-teardown-after)`,
  ran the teardown hook (pod terminated) and exited **4** with `status done, fetchOk false,
  teardownRan true, pending []`. 402 s.
- **Doc bug found by run 6:** README and `--help` said exit 4 = "teardown skipped". With
  `--force-teardown(-after)` the teardown does run and the code is still 4 (the artifacts are not
  local). Fixed both texts; the code is right, exit 4 keeps meaning "your artifacts are not here".
- **0.1.1 candidate:** "no file matches" is retried 25 times (5 rounds x 5). After the job has
  finished, an unmatched glob will not start matching, so the per-entry retry could stop on that
  error and leave only the force-teardown wait. Harmless (cost: 5 min of a $0.12/h pod), not fixed now.

### M5 acceptance (Plan v2.1)

| gap from the plan | where it lives now |
| --- | --- |
| periodic sync during the run | **left in Python** (`monitor()`: rsync every SYNC_S while remote-done waits). remote-done 0.2 `every:` would take it. |
| balance gate | **left in Python** (`monitor()` checks the balance at each sync; below MIN_BALANCE it SIGTERMs remote-done, which aborts -> fetches -> tears down -> exit 143). Proven by the abort run. |
| resume on a running pod | **split**: Python decides (state.json + pod API); remote-done waits on `--process n35_fast.py --exit-file run.log.rc --progress-log run.log` (dry-run verified; not run live). |
| composite probe (pgrep + log tail + error grep) | **covered by remote-done**: process + exit file in run mode, `--stall` on the run log, rc != 0 = fail. |
| wrapper terminates on any rc != 0 | kept: after remote-done returns, `teardownRan == false` -> sync + `terminate()`. |
| `--profile pod` | used for every invocation. |

Cost of all six live runs: about 6 pod-minutes x6 on $0.12-0.13/h GPUs, well under $0.10.
