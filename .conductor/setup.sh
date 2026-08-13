#!/usr/bin/env bash
set -euo pipefail

# Conductor runs this in a non-interactive shell, which has neither pnpm nor nvm
# on PATH. Both are resolved here rather than assumed.
# The macOS installer puts the binary in $PNPM_HOME/bin; the Linux one puts it
# directly in $PNPM_HOME. Both are added so this works either way.
export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install it with: curl -fsSL https://get.pnpm.io/install.sh | sh -" >&2
  exit 1
fi

# nvm is a shell function, so it must be sourced before .nvmrc can be honoured.
# `nvm install` reads .nvmrc and installs the version if it is missing, where
# `nvm use` would fail on a machine that has never built this repo.
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ -s "$NVM_SH" ]; then
  # shellcheck source=/dev/null
  . "$NVM_SH"
  nvm install
fi

pnpm install --frozen-lockfile
