#!/usr/bin/env bash
# Runs the direct OpenAI path from inside WSL with Linux Node, for parity with the Windows numbers.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:$PATH"
cd "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors"
node bench.mjs --path oa-luna-none --concurrency 10 --rounds 3 --tag wsl --timeout 30000 2>&1 | grep -E '^\{' | cut -c1-560
