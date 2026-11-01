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
