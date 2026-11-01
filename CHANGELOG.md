# Changelog

## 0.1.0 (unreleased)

- First release: wait for log markers / exit files / processes / ports / http / files /
  commands, locally or over ssh; fetch artifacts (scp/rsync); on-status hooks, gated
  teardown (`--profile pod`), notify (ntfy, webhook, shell); `run` subcommand with a
  crash-safe detached start; NDJSON mode; meaningful exit codes (0-8, 64, 128+signo).
