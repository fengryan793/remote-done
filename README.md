# remote-done

**wait-on for remote jobs.** Wait for a long job - local or on a box you reach over ssh - to
finish, then fetch its artifacts, run your hooks (notify, tear the pod down) and exit with a
code that means something. CLI + TypeScript library, zero runtime dependencies, Node >= 20.

```bash
# wait for a training run on a GPU pod, pull the outputs, stop the pod, ping your phone
remote-done --ssh root@1.2.3.4:22011 -i ~/.ssh/id_ed25519 \
  --log /workspace/run.log --done 'TRAINING COMPLETE' --fail 'Traceback|CUDA out of memory' \
  --timeout 6h --stall 30m \
  --fetch '/workspace/out/*.safetensors:./checkpoints' \
  --teardown 'runpodctl stop pod $POD' --profile pod \
  --notify ntfy://ntfy.sh/my-topic
```

```bash
# start a command detached on the target and wait for it (exit code comes from <log>.rc)
remote-done run --ssh gpu --log /tmp/render.log --fail Traceback \
  --fetch '/tmp/out/*.mp4:./renders' -- python render.py --scene 12
```

Why: the "`/loop`: check the log every 5 minutes, scp the result, stop the pod" routine kept
being rewritten as bash and Python one-offs. `wait-on` only knows local resources; nothing on
npm did wait -> fetch -> hooks over ssh with sane failure semantics.

## Install

```bash
npm i -g remote-done        # CLI
npm i remote-done           # library
```

Needs the system `ssh`/`scp` (and `rsync` if you ask for it), key-based auth, and a POSIX
`sh` on the target (Linux and macOS are both tested in CI; no Windows remotes).

## Conditions

Give one or more; several are combined with **all** (or `--any`).

| flag | done when | notes |
| --- | --- | --- |
| `--log PATH --done RE [--fail RE] [--from-start]` | a line matches `--done` | tails from the current end by default; byte-offset based, so a 2 GB log costs nothing; rotation/truncation handled |
| `--exit-file PATH` | file content is `0` | anything else = fail (the nohup `echo $? > job.rc` pattern) |
| `--process PID\|PATTERN` | the process is gone | alone this is status **exited** (exit 6, outcome unknown); pair with `--exit-file` or `--fail` |
| `--port N [--port-host H] [--port-closed]` | something listens | checked from the target's side |
| `--http URL [--status 200,201] [--body-match RE] [--fail-match RE]` | status + body match | evaluated **locally**; for a remote-only URL use `--cmd 'curl -fsS ...'` |
| `--file PATH [--stable 30s] [--min-bytes N]` | the file exists (and stopped growing) | |
| `--cmd 'CMD' [--fail-from 100]` | exit 0 | exit >= 100 = fail, anything else = keep polling; runs **every** poll, make it idempotent |

Timing: `--interval 15s` (default), `--timeout 2h`, `--stall 20m` (needs a change source: a
log/file/http/cmd condition or `--progress-log PATH`), `--unreachable-after 10m`.

## What happens at the end

```
terminal state -> fetch (statuses in --fetch-on) -> on-<status> hooks -> teardown? -> notify
```

- **fetch**: `--fetch 'REMOTE_GLOB[:LOCAL_DIR]'`, repeatable, `--rsync` to use rsync. Each entry
  is retried 5x with backoff. An unmatched glob is a fetch error.
- **teardown** (`--teardown CMD`) is where destructive things go. It runs only when
  `(done AND every fetch succeeded)` or `(status != done AND status in --teardown-on)`.
  Default `--teardown-on done`. With `--profile pod` (= `--teardown-on all --fetch-on all
  --force-teardown-after 5`) every exit path fetches first and then tears down, which is what you
  want for an hourly-billed pod. `--force-teardown` tears down even when a fetch failed.
- **hooks** (`--on-done/--on-fail/--on-timeout/--on-unreachable/--on-abort/--on-stalled`) run via
  `sh -c` with stdin = `/dev/null`, env `RD_STATUS RD_MATCH RD_FETCHED RD_FETCH_OK RD_ELAPSED_MS
  RD_TARGET RD_CTX_FILE` (a JSON file with the whole context), a 10 min timeout each, output
  captured. `unreachable`, `aborted`, `stalled` and `exited` are **notify-only** by default: they
  never fall back to `--on-fail`, so a flaky network cannot trigger your failure handler.
- **notify** (`--notify`) runs for every terminal state: `ntfy://ntfy.sh/topic`, an
  `https://` webhook (POST JSON) or any shell command.
- `--deadman CMD` arms `sleep timeout+10m && CMD` on the target as a safety net in case this
  process dies; it is disarmed when the job is done or torn down.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | done and every fetch succeeded |
| 1 | fail marker / non-zero exit file / command failed |
| 2 | timeout |
| 3 | target unreachable past `--unreachable-after` (or auth refused) |
| 4 | job done but a fetch failed; **teardown skipped**, pending command printed |
| 5 | stalled (no progress for `--stall`) |
| 6 | process exited, outcome unknown |
| 7 | ssh host key changed (never retried; the one-line fix is printed) |
| 8 | job fine, but a teardown/notify hook failed |
| 64 | bad arguments |
| 128+n | aborted by signal n (130 Ctrl-C, 143 SIGTERM, 129 SIGHUP); `--on-abort` ran |

On exit 3-7 the teardown command that did **not** run is printed to stderr and kept in
`~/.cache/remote-done/<id>.json`.

## ssh details

- Every remote command runs as `sh -c '<cmd>'; printf '\n__RD_RC=%s\n' $?`. A missing sentinel
  is a *transport* error (reconnect with 3 s -> 60 s backoff), never a job failure.
- `--host-key accept-new` (default) pins the key into a per-run file under
  `~/.local/state/remote-done/known_hosts.d/`, so a reused ip:port never meets a stale pin, and a
  key that changes **during** a run stops the wait with exit 7. `insecure` disables checking
  (community pods), `strict` uses only your own known_hosts.
- Polls are one ssh exec each; a `ControlMaster` option is planned for 0.2.
- `remote-done run` starts the job as
  `nohup sh -c 'echo $$ > LOG.pid; (CMD) > LOG 2>&1; echo $? > LOG.rc' &`. If the connection
  drops right after the start, the pid file is probed before anything is started again.
- RunPod: only pods with a public IP and exposed 22/tcp ("Full SSH"); the `ssh.runpod.io`
  proxy has no SCP/SFTP and is rejected with a hint.
- Values that start with `-` need `--flag=value` (e.g. `--ssh-arg=-oProxyJump=bastion`).
  Remote paths with spaces are not supported by `--fetch` in 0.1.

## Library

```ts
import { remoteDone, conditions as c, ssh } from "remote-done";

const r = await remoteDone({
  target: ssh("root@1.2.3.4:22011", { identity: "~/.ssh/id_ed25519" }),
  until: c.any(
    c.log("/workspace/run.log", { done: /DONE/, fail: /Traceback/ }),
    c.exitFile("/workspace/run.rc"),
  ),
  timeout: "2h",
  stall: "20m",
  fetch: [{ from: "/workspace/out/*.mp4", to: "./downloads" }],
  teardown: ["runpodctl stop pod $POD"],
  teardownOn: ["all"],
  onFail: [async (ctx) => notifySlack(ctx)],
  notify: ["ntfy://ntfy.sh/my-topic"],
});
console.log(r.status, r.exitCode, r.fetched);

// or consume events
for await (const ev of watch(spec)) console.log(ev.type);
```

`--json` prints the same events as NDJSON on stdout (nothing else is written there), which is
what to feed another tool or an agent loop.

## Status

0.1.0 - see [CHANGELOG](CHANGELOG.md). Planned for 0.2: periodic fetch (`every`),
`status`/reattach, ControlMaster, Slack/Telegram notifiers.

MIT (c) Ryan Feng
