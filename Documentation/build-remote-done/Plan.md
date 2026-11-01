# Plan - Build `remote-done` (v2.1, 2026-10-31, after adversarial review)

Edits are tagged with the challenge that motivated them. Unchanged text from Plan v1 is kept.

## Goal
"wait-on for remote jobs": wait for a long job (local or over ssh) to finish, then fetch artifacts,
run hooks (notify, teardown) and exit with a meaningful code. CLI + library, zero runtime deps,
Node >= 20, ESM, TypeScript. Repo ~/Documents/remote-done, GitHub fengryan793/remote-done,
npm `remote-done` (checked 2026-10-31: 8 name variants 404, no scoped collision, GitHub slug free) (R1-C5).

## Decision record: delivery vehicle (R5-C1, R5-C2)
Options weighed: (a) standalone package (chosen); (b) `comfy-resolve wait` subcommand - saves
~1 dev-day (scaffold + release) but is off-audience (comfy-resolve's README/keywords are ComfyUI-only)
and would bloat its single parseArgs table; (c) keep the bash/Python loops (native35 orchestrate.py
already does more than 0.1) - no reuse across projects, no safety guarantees. Decision for Ryan to
confirm: (a), with the Python loop calling remote-done for its wait/teardown branch until 0.2 adds
periodic fetch. Competitors recorded: rwatchd (ssh poll-until-regex + hooks, lib only, 22 dl/wk,
no fetch/CLI), pi-process-monitor (agent extension, notify only, 818 dl/wk), awaitless-runner (PyPI),
wait-on (local only) (R3-C1).

## Non-goals (0.1)
- No scheduler/queue; no provider API calls (teardown is the user's command).
- ssh = system `ssh`/`scp`/`rsync`, key auth only, no ssh2.
- **RunPod: only pods with a public IP + exposed 22/tcp ("Full SSH"); the `ssh.runpod.io` basic proxy
  has no SCP/SFTP (RunPod docs) and is rejected fast with a hint** (R1-C3).
- No ControlMaster in 0.1 (moved to 0.2 with a full lifecycle; ~0.3 s/poll saving is not worth two
  documented races and orphan masters) (R4-C4).
- No Windows remotes; local mode is POSIX-only too (nohup/sh -c) - say so (R4 note).

## Design

### M0.5 design freeze (new, before any engine code) (R5-C4)
Write `src/types.ts` and a one-page decision table covering, in this order: status enum and
precedence; transport-error classification; fetch policy and teardown gating; hook contract and
stdio; stall sources. The FakeSsh/failing-transport tests belong to M1, not M2.

### Core model
```
Target     = local | ssh { host, user?, port?, identity?, hostKey?: "accept-new"|"strict"|"insecure", sshArgs? }
Condition  =
  log       { path, done, fail?, fromStart? }          # line-framed; see Tailing
  exitFile  { path }                                   # content = exit code
  process   { pid? | pattern?, exitFile?: path }       # "exited", not "succeeded": alone it only yields
                                                       # status "exited"; pair with exitFile/log.fail (R2-C1)
  port, http { url, status?, bodyMatch?, failMatch?, insecure? }   # http is evaluated LOCALLY with
                                                       # fetch(); remote http = command + curl (R1-C2)
  file      { path, exists?, stableFor?, minBytes? }
  command   { cmd }                                    # done exit 0; fail exit >= 100 (remote code only,
                                                       # never a transport error) (R3-C2)
  all / any { conditions[] }
Spec = { target, until, interval=15s, timeout?, stall?, fetch?: [{from, to, via?}],
         fetchOn = ["done","fail","timeout"], teardown?: Hook[], teardownOn = ["done"],
         onDone?, onFail?, onTimeout?, onUnreachable?, onAbort?, notify?, keepGoing=true }
Result = { status: "done"|"fail"|"timeout"|"unreachable"|"stalled"|"aborted"|"exited",
           fetched[], fetchErrors[], hooks[], elapsedMs, matched? }
```
Exit codes: 0 done (= done AND fetched) · 1 fail · 2 timeout · 3 unreachable · 4 done-but-fetch-failed ·
5 stalled · 6 exited (process gone, outcome unknown) · 7 hostKeyChanged · 64 bad args ·
128+signo aborted (130 INT / 143 TERM / 129 HUP; `Result.signal` recorded) (R2-C2, R3-C3, RC-C5).

### Precedence and hooks (R2-C2, R5-C5)
`timeout` (wall clock, never paused) > `unreachableAfter` (only while disconnected) > `stall`
(only while connected; frozen during reconnect). `onUnreachable`, `onAbort` and `stalled` default to
**notify only** - they never fall back to `onFail`. Destructive actions go in `teardown`, which runs
only when `(status == done && fetch ok) || (status != done && status ∈ teardownOn)`; `done` in
`teardownOn` always means done-and-fetched (RC-C1). `teardownOn` accepts `all` and the CLI offers
`--profile pod` = `--teardown-on all --fetch-on all --force-teardown-after 5` for hourly-billed
pods, reproducing orchestrate.py's "fetch first, then terminate on every exit path" (RC-C1).
Before teardown on fail/timeout/unreachable a best-effort fetch is attempted (`fetchOn`).
`notify` runs for every terminal state; on exit 3/4/5/6/7 the pending teardown command from the
state file is printed to stderr. README example becomes
`--teardown 'runpodctl stop pod $POD' --on-fail 'ntfy …'` (and `--profile pod` for RunPod).

### Stall sources (R4-C2)
Each condition may expose `changeKey()`: log -> byte size, file -> size+mtime, http -> body hash,
command -> stdout hash. exitFile/process/port expose none. `--stall` is rejected (exit 64) unless the
root condition, or one child of `all/any`, has a changeKey, or `--progress-log PATH` is given.
`file.stableFor` is evaluated before stall (stable -> done).

### Fetch policy (R3-C3)
Fetch runs for statuses in `fetchOn`; each target retried (5x, backoff) and may carry
`stableFor`/`minBytes`; `scp -q` (OpenSSH >= 9 sftp mode exits 1 on an empty glob) / `rsync -az`
without progress; an unmatched glob is a fetch error -> `Result.fetchErrors`, `RD_FETCH_OK=0`,
status stays `done` but exit code 4 and `teardown` is skipped (unless `--force-teardown` /
`--force-teardown-after N`, both listed in the CLI section) (RC-C1).

### Transports (R3-C2, R5-C3, R1-C4)
`SshTransport` argv: `-n -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15
-o ServerAliveCountMax=3 -o StrictHostKeyChecking=<policy> -o UserKnownHostsFile=<managed file>`.
Host-key policy (`--host-key`, a real decision for Ryan, see Decisions): `accept-new` (default
proposal) pins into a per-run file `~/.local/state/remote-done/known_hosts.d/<host>_<port>_<runId>`
so a reused ip:port never meets a stale pin; `insecure` = `StrictHostKeyChecking=no +
UserKnownHostsFile=/dev/null` (what orchestrate.py uses today); `strict` = user's known_hosts only.
`REMOTE HOST IDENTIFICATION HAS CHANGED` / `Offending … key in <file>:<line>` is a terminal class
`hostKeyChanged`: stop at once, exit 7, message carries the file:line and the fix
`ssh-keygen -R '[<host>]:<port>' -f <file>`, notify runs - never the reconnect loop (RC-C3).
Every remote command runs as `sh -c '<cmd>'; printf '\n__RD_RC=%s\n' $?`; the sentinel line (and the
newline it adds) is stripped before any hashing/carry/stat parsing (RC-C4). Exit 255 **without** the
sentinel, or stderr matching transient ssh-client patterns (`^ssh: connect`, `Connection
(closed|reset|timed out)`, `kex_exchange_identification`, `client_loop: send disconnect`,
`Timeout, server .* not responding`) is a `transportError`. Idempotency rule (RC-C4): reads
(tail/stat/pgrep/cat rc/kill -0) are retried freely; `run` start and `command {cmd}` are
non-idempotent - on sentinel loss the engine re-probes first (`cat <log>.pid`/`<log>.rc`,
`kill -0 $pid`, or `--idempotency-check CMD`) and never re-executes blindly; if the probe cannot
run, the result is `unreachable`. `run` writes `<log>.pid` before anything else. Calls are serialised.
Reconnect: 3 s -> 60 s exponential, `unreachableAfter` default 10 min.

### Tailing (R1-C4)
`readTail` is ONE exec, size-first and bounded (RC-C2):
`S=$(stat -c %s F 2>/dev/null || stat -f %z F); I=$(stat -c '%i %d' F 2>/dev/null || stat -f '%i %d' F);
printf '__RD_STAT %s %s\n' "$I" "$S"; tail -c +$((N+1)) F | head -c $((S-N))` - GNU `%s` is size but
GNU `%z` is ctime, BSD size is `%z`, so the dialect is chosen by the inline fallback (or a cached
`uname -s` probe), never one hard-coded format. `offset += bytes.length` always; `size` is used only
for the shrink test and `ino/dev` for rotation; never `offset = size`. Carry buffer = bytes after the
last `\n`, keeping the LAST 64 KiB of an over-long partial line (floor = longest marker length - 1) so
a marker is never split; match `done`/`fail` per complete line on carry+window decoded once
(`StringDecoder`); when `size` is unchanged for one further poll (or at timeout) the carry is
evaluated as a line even without a trailing `\n` (`echo -n DONE`). Restart from 0 when `ino/dev`
changed or `size < offset`. Documented limit: copytruncate + regrowth past the old offset on the same
inode between two polls is undetectable; advise `--interval` shorter than the rotation window.

### `run` subcommand (R1-C1, R2-C1)
Start: `nohup sh -c '<cmd> > <log> 2>&1; echo $? > <log>.rc' </dev/null >/dev/null 2>&1 & echo $!`;
quote `<cmd>` for the inner `sh -c`; keep the pid for `process`; `exitFile` treats "rc absent + pid
gone" as fail. Optional remote dead-man: `--deadman CMD` arms `nohup sh -c "sleep $((timeout+grace))
&& CMD" &` on the target; onDone kills it (R2-C3). `pattern` is executed as a bare `pgrep -f -- '<re>'`
(no compound command), or `[p]ython` bracket idiom.

### Hooks and stdio (R4-C1, R5-C5, R2-C3)
Shell hooks: `stdio: ["ignore","pipe","pipe"]` (stdin = /dev/null; ssh inside a hook cannot swallow
anything), context via `RD_CTX_FILE` (temp JSON, `events` omitted) + RD_* env; stdout/stderr captured
(last 4 KB) into `hook` events and echoed to stderr in human mode. Per-hook timeout 10 min then kill.
In all modes only the engine writes to stdout; human poll lines go to stderr; `--json` = NDJSON only.
Signals: first SIGINT/SIGTERM/SIGHUP -> stop polling, run `onAbort` (notify) within the hook timeout,
exit 128+signo; second -> exit at once (RC-C5). `process.on('exit')` is sync-only and cannot be the mechanism.
darwin: spawn `caffeinate -i -w <pid>` unless `--no-caffeinate`. State file
`~/.cache/remote-done/<id>.json` written at start (target, spec, deadline) so a killed waiter leaves
the pending teardown command discoverable; full `status`/reattach stays 0.2.

### CLI (R4-C3)
parseArgs with `multiple: true` for `--fetch`, `--on-*`, `--teardown`, `--notify`; `--fetch
'REMOTE_GLOB[:LOCAL_DIR]'` (default dir = last `--to` or `./`); values starting with `-` must use
`--flag=value` (documented in --help); `--host-key`, `--teardown`, `--teardown-on` (incl. `all`),
`--fetch-on`, `--force-teardown`, `--force-teardown-after N`, `--profile pod`, `--progress-log`,
`--deadman`, `--idempotency-check`, `--no-caffeinate` added (RC-C1, RC-C4).

## Milestones (dev-days of focused work, not calendar time) (R2-C5)
- **M0 scaffold** 0.5 d: package, tsconfig, tsup, vitest, CI matrix **os: [ubuntu-latest, macos-latest]
  x node: [20, 22, 24, 26]** with an "enable ssh localhost" step (ssh-keygen + authorized_keys; both
  runner images already run sshd) and `RD_TEST_SSH=1` so remote recipes execute on GNU and BSD
  userlands in every CI run (R3-C4, R3-C5).
- **M0.5 design freeze** 0.5 d (R5-C4).
- **M1 engine** 1 d: conditions, poll loop, precedence, stall sources, hooks/stdio, Result; tests
  with temp files, child process, local http server AND FakeSsh incl. transport-error, drop-during-stall,
  straddled/UTF-8/rotated markers, empty fetch glob, SIGTERM -> onAbort.
- **M2 ssh transport + fetch** 1 d: argv/host-key policy, sentinel, reconnect, tailing, scp/rsync, `run`.
- **M3 CLI** 0.5 d. **M4 release** 0.5 d - external dependency: Ryan present for npm's /auth/cli
  web-auth (minutes when scheduled; comfy-resolve waited 13 calendar days for lack of a slot); book it
  when M3 lands.
- **M5 dogfood** 0.5-1 d: target = the live native-35 routine in
  ~/Documents/personalProject/ai-video-temp-file/native35-runpod/orchestrate.py on `ubuntugpu`
  (always-on, zero extra cost), replacing its STOPPED/unreachable branch and the Claude-side
  `tail -n 0 -F … | grep` loops; acceptance = the four gaps (periodic sync, balance gate, resume,
  composite probe) are either covered or explicitly left in Python; the Python wrapper keeps
  terminating on any rc != 0, and the dogfood invocation uses `--profile pod` (RC-C1). ai-short-video stays a README
  example only (its pods are gone; re-provisioning costs ~1 h + H100 billing) (R4-C5, R5-C1).
- Total M0-M4 ≈ 4 dev-days.
- **0.2**: `every: {interval, fetch?, hook?}` (periodic sync + user command slot), `status`/reattach,
  ControlMaster with lifecycle, `--progress` parsing, Slack/Telegram notifiers.

## Risks (rewritten) (R5-C2)
1. Transport error misread as job failure -> false teardown (mitigated by sentinel; residual: remote
   command legitimately exits 255 without sentinel line being flushed).
2. Teardown before artifacts are safe (mitigated by fetchOn/teardownOn/exit 4).
3. `process` gone != success (mitigated by "exited" status; residual for pattern mode).
4. Unreachable/abort with a billing pod (mitigated: notify-only defaults + state file + optional dead-man;
   residual: SIGKILL/power loss without dead-man).
5. `--json` stream purity (mitigated by stdio contract).
6. Host-key policy on reused ip:port: changed key fails fast with exit 7 + one-command fix; per-run
   known_hosts avoids stale pins; `insecure` remains the documented choice for community pods.
8. Sentinel lost in flight after a non-idempotent command ran (mitigated by re-probe rule; residual:
   probe itself unreachable -> status unreachable, job may be running twice only if the user retries).
7. Demand outside us unproven; rwatchd exists as a library-only sibling.

## Decisions to confirm with Ryan
1. Vehicle: standalone `remote-done` (vs `comfy-resolve wait`, vs keep Python).
2. System ssh (zero deps), Node >= 20 engines with CI on 20/22/24/26 (or bump floor to 22).
3. Defaults: onUnreachable/onAbort notify-only with `--profile pod` as the one-flag opposite;
   teardown gated on fetch; host-key default `accept-new` (per-run file + fast-fail) **or** `insecure`
   as orchestrate.py does - Ryan picks.

---

## Superseded: Plan v1 (2026-10-31, before the disagree-agent review)

Kept for history. The adversarial review that replaced it is in Verification.md (same date).

## Plan - Build `remote-done`

### Goal
An npm package (CLI + library, zero runtime deps, Node >= 20, ESM, TypeScript) that waits
for a long job - local or on a remote box over ssh - to finish, then does the follow-up:
fetch artifacts, run onDone / onFail / onTimeout hooks (teardown, notify), and exit with a
meaningful code. "wait-on for remote jobs." Replaces our recurring "/loop: check /tmp/x.log
every 5 min; when DONE scp the mp4, send it, tear down the pod" routine.

Repo: `~/Documents/remote-done`, GitHub `fengryan793/remote-done` (via github_ryan MCP +
`github-ryan` ssh alias), npm name `remote-done` (free as of 2026-10-31; `wait-done` also free).
Research that justifies it: `Documentation/research-remote-done/Findings.md`.

### Non-goals (0.1)
- Not a job scheduler / queue (no submit-and-track database; see awaitless-runner).
- Not a provider CLI (no RunPod/AWS API calls built in - teardown is *your* hook command).
- No ssh2 / native ssh implementation: shell out to the system `ssh` / `scp` / `rsync`
  with `BatchMode=yes` (key auth only). Keeps zero deps and uses the user's `~/.ssh/config`.
- No password / interactive prompts, no Windows remote hosts (local mode works anywhere).

### Design

#### Core model
```
Target     = local | ssh { host, user?, port?, identity?, sshArgs?, controlMaster? }
Condition  = one of
  log       { path, done: RegExp|string, fail?: RegExp|string, fromStart?: boolean }   # tail from current size by default
  exitFile  { path }                                  # file whose content is the exit code (Airflow/nohup pattern)
  process   { pid?: number, pattern?: string }        # done when it is gone
  port      { port, host? }                           # done when open  (or `closed: true`)
  http      { url, status?: number[], bodyMatch?: RegExp, insecure?: boolean }
  file      { path, exists?: true, stableFor?: ms, minBytes?: number }
  command   { cmd }                                   # done when exit 0 ; fail when exit >= 100 (configurable)
  all / any { conditions[] }                          # combinators
Spec = {
  target, until: Condition,
  interval?: ms (default 15s), timeout?: ms, stall?: ms (no log growth / no change -> fail),
  fetch?: [{ from: remoteGlob, to: localDir, via?: "scp"|"rsync" }],
  onDone?: Hook[], onFail?: Hook[], onTimeout?: Hook[],   # Hook = shell string | (ctx) => Promise
  notify?: { ntfy?: topicUrl, webhook?: url, stdout?: boolean },
  keepGoing?: boolean   # continue polling across ssh drops (reconnect with backoff) - default true
}
Result = { status: "done"|"fail"|"timeout"|"unreachable", elapsedMs, matched?: string,
           fetched: string[], hooks: {name, exitCode, ms}[], events: Event[] }
```
Exit codes: 0 done, 1 fail (fail marker / nonzero exit file / hook failed), 2 timeout,
3 target unreachable past the reconnect budget, 64 bad arguments.

#### Transports
`Transport { exec(cmd, {timeout}) -> {code, stdout, stderr}; readTail(path, fromByte) -> {bytes, size};
stat(path); fetch(glob, toDir) }`. `LocalTransport` uses child_process + fs; `SshTransport`
wraps the `ssh` binary (`-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15`), an
optional ControlMaster socket for cheap repeated polls, `scp -r` / `rsync -az` for fetch, and
an exponential-backoff reconnect (3 s -> 60 s, budget `unreachableAfter`, default 10 min).
Log tailing is byte-offset based (`tail -c +N` remotely, `fs.read` locally) so a 2 GB log
costs nothing per poll; handles truncation/rotation (size shrank -> restart from 0).

#### Engine
Single poll loop: `tick()` evaluates the condition through the transport, emits typed
events (`poll`, `progress`, `matched`, `reconnect`, `fetch`, `hook`, `result`), tracks the last
change time for `stall`, enforces `timeout` with an AbortController, then runs the
fetch -> hooks -> notify pipeline for the terminal state. Hooks get env vars
(`RD_STATUS`, `RD_MATCH`, `RD_FETCHED` (newline list), `RD_ELAPSED_MS`, `RD_TARGET`) and JSON
on stdin. Everything is also usable as `for await (const ev of watch(spec))`.

#### CLI
```
remote-done [--ssh [user@]host] [-p PORT] [-i KEY]
            --log /tmp/x.log --done 'DONE' [--fail 'ERROR|Traceback'] [--from-start]
          | --exit-file /tmp/x.rc | --process 'python train.py' | --port 8188 | --http URL
          | --file /out/final.mp4 --stable 30s | --cmd 'test -f /out/.ok'
            [--interval 15s] [--timeout 2h] [--stall 20m]
            [--fetch '/out/*.mp4' --to ./downloads] [--rsync]
            [--on-done './teardown.sh'] [--on-fail 'runpodctl stop pod $POD'] [--on-timeout ...]
            [--notify ntfy://ntfy.sh/mytopic | --webhook URL]
            [--json] [--quiet] [--dry-run]
remote-done run [--ssh ...] --log /tmp/x.log -- python train.py   # start detached on the target
            (nohup ... > log 2>&1; echo $? > log.rc) and then wait on the .rc file + log
remote-done status <id>   # 0.2: reattach to a `run` started earlier (state file under ~/.cache)
```
Human output: one compact line per poll (elapsed, last log line / size), final summary;
`--json` emits one event per line (NDJSON) for other tools / Claude loops.

#### Library
```ts
import { remoteDone, watch, conditions as c, ssh, local } from "remote-done";
const r = await remoteDone({
  target: ssh("root@1.2.3.4", { port: 22011, identity: "~/.ssh/id_ed25519" }),
  until: c.log("/workspace/run.log", { done: /DONE/, fail: /Traceback/ }),
  timeout: "2h", stall: "20m",
  fetch: [{ from: "/workspace/out/*.mp4", to: "./downloads" }],
  onDone: ["./teardown.sh"], onFail: [async (ctx) => notifySlack(ctx)],
});
```

### Milestones
- **M0 scaffold** (0.5 d): package.json (bin `remote-done`), tsconfig strict, tsup, vitest,
  CI (Node 20/22), README skeleton, LICENSE MIT, Documentation/ in repo.
- **M1 engine + local transport** (1 d): durations parser, conditions (log/exitFile/process/
  port/http/file/command/all/any), poll loop, stall + timeout, events, hooks + env, Result.
  Tests: temp files + a child process that writes a log, local http server, `all/any`.
- **M2 ssh transport + fetch** (1 d): ssh/scp/rsync wrappers, ControlMaster, byte-offset tail,
  reconnect/backoff, `unreachable` state. Tests: a `FakeSsh` transport in-process for the
  engine; one opt-in integration test against `ssh localhost` (skipped unless RD_TEST_SSH=1).
- **M3 CLI** (0.5 d): flag parsing (node:util parseArgs), NDJSON mode, exit codes, `run`
  subcommand (detached start + .rc file), notify (ntfy / webhook via fetch).
- **M4 release** (0.5 d): README with the RunPod/ComfyUI/training examples, CHANGELOG,
  `npm pack` review, publish 0.1.0 (token in Keychain; publish still needs Ryan's web-auth
  click), tag + GitHub release.
- **M5 dogfood**: replace the `/loop` + scp + teardown routine in ai-short-video with
  `remote-done` (one script in `.runpod/`), and wire `comfy-resolve download` + `remote-done`
  together in the docs. Record findings back here.
- **0.2 ideas**: `status`/reattach, multiple targets, progress parsing (`--progress '(\d+)%'`),
  Slack/Telegram notifiers, a Claude Code skill wrapper.

### Risks / open questions
- Marker already present when we start (re-runs): default tail-from-current-size; `--from-start` opt-in.
- ssh asks for a passphrase/host key: BatchMode fails fast with exit 255 -> clear error + hint.
- Hooks that never exit (e.g. interactive teardown): per-hook timeout (default 10 min) + kill.
- Demand outside us is unproven (see research); keep scope at 0.1 and measure after dogfood.

### Decisions to confirm with Ryan
1. Name `remote-done` (alternatives: `wait-done`, `remote-wait`).
2. Shell out to system ssh (zero deps) rather than `ssh2` - yes unless Windows remotes matter.
3. Same stack/conventions as comfy-resolve (ESM-only, Node >= 20, tsup, vitest, MIT, no deps).

## 2026-11-01 - M5 dogfood plan (Ryan: "先 M5 dogfood")

Goal: run remote-done inside the real native-35 RunPod routine (`orchestrate.py` on ubuntugpu),
replacing the hand-written monitor loop (pgrep poll / unreachable counter / final sync / terminate).

Findings that shape the plan:
- The native-35 batch finished on 2026-10-31 (state.json phase=done, 90719 JSONs local, 2 clips left
  without JSON). There is no live run to attach to, so the dogfood needs a run of its own.
- ubuntugpu has no Node; install Node 24 LTS user-level under ~/.local (no sudo).
- ubuntugpu cannot ssh to itself (its key is not in its own authorized_keys), so a free
  "pod stand-in" is only possible via docker (if usable) or the Mac; otherwise the real pod.

Steps:
1. Node 24 on ubuntugpu + `npm pack` remote-done locally + `npm i -g <tgz>` there (also validates the pack).
2. orchestrate.py: keep grab/boot/upload/balance/periodic-sync/resume in Python; hand
   start+wait+fetch+teardown to `remote-done run --json --profile pod` as a subprocess. Add
   `--terminate POD` (teardown hook target) and `--dogfood` (process the leftover clips on the
   cheapest community GPU, 20 min timeout) entry points.
3. Verify: `--dry-run`, then a real run; record every rough edge in Findings.md.
4. Acceptance per Plan v2.1: periodic sync / balance gate / resume / composite probe each covered
   or explicitly left in Python; the wrapper still terminates on any rc != 0.
- 2026-11-01 status: M5 done as a dogfood of the same orchestrate.py code path on cheap pods (the
  native-35 batch had already finished). Remaining: M4 release (needs Ryan's web-auth click and the
  repo flipped to public).
