# Changelog

## 0.1.1 (2026-11-01)

- A fetch glob that matches nothing is no longer retried (5 attempts, then 5 min of
  `--force-teardown-after` rounds) once an exit file or a gone process proves the job ended. After
  a log marker it still retries, because a job may print `DONE` before its outputs are written.

## 0.1.0 (2026-11-01)

- First release: wait for log markers / exit files / processes / ports / http / files /
  commands, locally or over ssh; fetch artifacts (scp/rsync); on-status hooks, gated
  teardown (`--profile pod`), notify (ntfy, webhook, shell); `run` subcommand with a
  crash-safe detached start; NDJSON mode; meaningful exit codes (0-8, 64, 128+signo).
- `remote-done wait ...` is accepted as an explicit alias of the default (wait) mode.
- Dogfooded on real RunPod pods (done / abort / fail / stall / unreachable / fetch-failed):
  every path fetched first and terminated the pod through the teardown hook.
