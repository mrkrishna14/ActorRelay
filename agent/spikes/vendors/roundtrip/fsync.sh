#!/usr/bin/env bash
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
cp "$here/fsync-probe.ts" /tmp/ar-vendors-fsync-probe.ts
cat /proc/loadavg; df -h "$HOME" /dev/shm | tail -2
exec bun run /tmp/ar-vendors-fsync-probe.ts
