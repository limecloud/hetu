#!/bin/zsh
set -euo pipefail
exec python3 "$(dirname "$0")/tools/dev-mac.py" "$@"
