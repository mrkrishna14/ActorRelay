#!/usr/bin/env bash
# Tests whether Claude and Codex can answer headlessly from inside WSL. Prints exit codes and short output only.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:$PATH"
cd /tmp
echo "--- plain claude -p from WSL"
timeout 40 claude -p "Reply with the single word ok" --output-format text 2>&1 | head -3
echo "exit=${PIPESTATUS[0]}"
echo "--- plain codex from WSL"
timeout 20 codex --version 2>&1 | head -12
echo "exit=${PIPESTATUS[0]}"
echo "--- Windows claude.exe through WSL interop"
EXE=/mnt/c/Users/zubai/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
ls -la "$EXE" | head -1
cd /mnt/c/Users/zubai
start=$(date +%s%3N)
echo "Reply with the single word ok" | timeout 60 "$EXE" -p --model haiku --effort low --tools "" --no-session-persistence --strict-mcp-config --setting-sources "" --output-format text 2>&1 | head -3
echo "exit=${PIPESTATUS[1]} ms=$(( $(date +%s%3N) - start ))"
