#!/usr/bin/env bash
# Runs the adapter from WSL Bun: Linux side for OpenAI, the Windows codex.exe through interop for Codex.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:$PATH"
export CODEX_BIN=/mnt/c/Users/zubai/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe
export CLAUDE_BIN=/mnt/c/Users/zubai/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
cd "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors"
bun test ./adapter.test.ts --timeout 40000 2>&1 | tail -16 | cut -c1-220
