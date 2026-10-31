#!/usr/bin/env bash
# Mirrors web/ and shared/ onto the Linux filesystem and serves the dashboard on port 3000.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$PATH"
REPO="/mnt/c/Users/zubai/Haunted Hacks/Factoryio"
RUN="$HOME/ar-run"
mkdir -p "$RUN/web" "$RUN/shared"
cp "$REPO"/shared/* "$RUN/shared/"
(cd "$REPO/web" && tar --exclude=./node_modules --exclude=./.next -cf - .) | (cd "$RUN/web" && tar xf -)
cd "$RUN/web" || exit 1
bun install 2>&1 | tail -2
if ! ss -ltn | grep -q ':3000 '; then
  setsid nohup bunx next dev --hostname 0.0.0.0 --port 3000 > "$RUN/web.log" 2>&1 < /dev/null &
fi
sleep 4
bunx tsc --noEmit 2>&1 | tail -n 12 | cut -c1-140
tail -n 3 "$RUN/web.log" | cut -c1-120
