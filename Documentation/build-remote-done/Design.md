# Design freeze (M0.5) - `remote-done` 0.1

Date: 2026-10-31. Source of truth for the code is `src/types.ts`; this page is the one-page
decision table Plan v2.1 asked for, in the order it asked: status + precedence, transport-error
classification, fetch/teardown gating, hook contract + stdio, stall sources.

## 1. Status enum and precedence

| status | meaning | exit | on-hooks | notify |
| --- | --- | --- | --- | --- |
| done | condition satisfied | 0 (4 if a fetch failed, 8 if teardown/notify failed) | onDone | yes |
| fail | fail marker / rc != 0 / command >= failFrom / crashed before writing rc | 1 | onFail | yes |
| timeout | wall clock exceeded (never paused) | 2 | onTimeout | yes |
| unreachable | transport errors for `unreachableAfter` (10 m), or auth refused | 3 | onUnreachable | yes |
| stalled | no change source moved for `stall` | 5 | onStalled | yes |
| exited | process gone, outcome unknown | 6 | none | yes |
| hostKeyChanged | host key changed / unknown under strict | 7 | none | yes |
| aborted | SIGINT/TERM/HUP or AbortSignal | 128+signo | onAbort | yes |

Precedence while polling: **timeout > unreachableAfter (only while disconnected) > stall (only while
connected; the stall clock is frozen during reconnects) > condition result**. hostKeyChanged and
aborted interrupt at once. At timeout/stall the log carry buffer gets a final line check
(`echo -n DONE`).

Combinators: `all` = fail if any child fails; done when every child is done or exited with at
least one done ("DONE line + process gone"); exited when a child exited and the rest cannot be
completed; pending children get one immediate re-read before "exited" is concluded (the final
log line may land between two child reads). `any` = first done wins, any fail fails, exited only
when every child exited.

## 2. Transport-error classification (ssh)

| stderr / exit | class | action |
| --- | --- | --- |
| sentinel `\n__RD_RC=N\n` present | remote exit code N | normal |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | HostKeyError (file:line parsed) | stop, exit 7, print `ssh-keygen -R '[host]:port' -f FILE` |
| `Host key verification failed` (strict) | HostKeyError | stop, exit 7 |
| `Permission denied (publickey)` and friends | AuthError | status unreachable at once |
| `ssh: connect`, `Connection refused`, `Could not resolve`, `No route`, `kex_exchange_identification`, `Connection timed out` | TransportError phase **connect** | reconnect 3 s -> 60 s; nothing ran, safe to retry anything |
| `client_loop: send disconnect`, `Connection closed/reset by`, `Timeout, server not responding`, `packet_write_wait`, `Broken pipe` | TransportError phase **session** | reconnect; non-idempotent starts are probed first |
| exit 255 without sentinel, no pattern | TransportError (connect if no stdout, session otherwise) | reconnect |
| per-call timeout (2 m default) | TransportError phase timeout | reconnect |
| other exit without sentinel | returned as-is with `sentinel:false` | caller decides |

Idempotency: polls (tail/stat/ps/pgrep/cat/kill -0) retry freely. `run` start is non-idempotent:
after a session/timeout loss the engine waits 2 s and probes `<log>.pid` (or
`--idempotency-check CMD`); found -> adopt the pid; absent -> start again; probe unreachable ->
keep backing off until `unreachableAfter`, then unreachable. The wrapper writes `echo $$ >
LOG.pid` as its very first action.

## 3. Fetch policy and teardown gating

- fetch runs when `status in fetchOn` (default done,fail,timeout; `all` allowed); each entry is
  retried 5x with 2 s -> 30 s backoff; `stableFor`/`minBytes` are honoured via a remote
  `stat`-sum before copying (5 min readiness budget); an unmatched glob is a fetch error.
- `fetchOk = fetchErrors.length === 0`.
- teardown runs iff `(status == done && (fetchOk || forceTeardown))` or `(status != done && status
  in teardownOn)`; default teardownOn = [done]. `done` in teardownOn always means done-and-fetched.
- `forceTeardownAfter N` (minutes): when done but fetch failed, keep retrying the failed fetch for
  N minutes, then set forceTeardown. `--profile pod` = teardownOn all + fetchOn all +
  forceTeardownAfter 5.
- exit 4 = done, fetch failed, teardown skipped; the pending teardown command is printed and
  stored in the state file. A failing teardown/notify hook turns exit 0 into 8 (never masks
  another code).
- dead-man: armed before polling (`sleep timeout+grace && CMD`), disarmed when done or after
  teardown ran; otherwise left armed and announced.

## 4. Hook contract and stdio

- shell hooks: `sh -c HOOK`, `stdio: ["ignore","pipe","pipe"]`, env `RD_ID RD_PHASE RD_STATUS
  RD_TARGET RD_MATCH RD_FETCHED(newline list) RD_FETCH_OK RD_ELAPSED_MS RD_STARTED_AT RD_SIGNAL
  RD_ERROR RD_CTX_FILE` (temp JSON of HookContext, deleted after the hook); last 4 KiB of output
  captured into the `hook` event; 10 min timeout then TERM, KILL after 5 s.
- function hooks: `await fn(ctx)` under the same timeout.
- order: fetch -> on-<status> -> teardown -> notify. Only the engine writes to stdout: human mode
  prints one result line there, poll/hook/warn lines go to stderr; `--json` is NDJSON only.
- signals: first SIGINT/TERM/HUP aborts the wait (onAbort + notify run under the hook timeout),
  exit 128+signo; a second signal exits at once. macOS: `caffeinate -i -w <pid>` unless
  `--no-caffeinate`.
- state file `~/.cache/remote-done/<id>.json` (target, condition, teardown list, deadline,
  finished status); files older than 7 days are pruned at start.

## 5. Stall sources

| condition | changeKey |
| --- | --- |
| log | byte size |
| file | size:mtime |
| http | status:sha1(body) |
| command | sha1(stdout) |
| exitFile / process / port | none |
| `--progress-log PATH` | size of that file, appended to any key |

`--stall` is rejected (exit 64) unless the condition tree has a change source or
`--progress-log` is given. `file.stableFor` is evaluated inside the condition, so "stable" wins
over "stalled".

## Tailing (recap of Plan v2.1, as implemented in `src/tail.ts` + `src/recipes.ts`)

One exec per poll: `stat -c %s || stat -f %z` picks the GNU/BSD dialect inline, prints
`__RD_STAT ino dev size`, then `tail -c +$((N+1)) | head -c L` with `L = min(size-N, window)`.
`offset += bytes.length` always; `ino:dev` change or `size < offset` resets to 0 and re-reads at
once; carry buffer keeps the last 64 KiB of an unterminated line (floor = longest marker - 1);
lines are split on bytes so UTF-8 never breaks; an unterminated last line is judged when the
size stopped growing for one poll. Documented limit: copytruncate + regrowth past the old offset
on the same inode between two polls is undetectable (shorten `--interval`).
