#!/bin/bash
# Runs the contract suite on WSL Bun 1.4.4. Do not use the Windows Bun here: 1.3.14 merges same-named private
# methods across decorated classes, so Component would run Plant's #assertSeeded and every test would be a false failure.
# Usage, from PowerShell: wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/contract/run.sh" [test filter]
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")" || exit 1
bun --version
exec bun test --timeout 240000 "$@"
