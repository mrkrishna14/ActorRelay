#!/usr/bin/env bash
# Reports which vendor CLIs and logins exist inside WSL. Prints names only, never values.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:$PATH"
echo "user=$(whoami)"
for c in claude codex node bun npm; do
  p=$(command -v "$c" 2>/dev/null || true)
  echo "$c => ${p:-missing}"
done
echo "--- claude version"; timeout 15 claude --version 2>&1 | head -1
echo "--- codex version"; timeout 15 codex --version 2>&1 | head -1
echo "--- ~/.claude"; ls -la ~/.claude 2>&1 | head -12
echo "--- creds"; ls -la ~/.claude/.credentials.json 2>&1
echo "--- ~/.codex"; ls -la ~/.codex 2>&1 | head -8
echo "--- env names"; env | cut -d= -f1 | grep -iE 'anthropic|claude|openai|codex' || echo none
