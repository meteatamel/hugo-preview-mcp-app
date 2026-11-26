#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${HOME}/.gemini/config/plugins/hugo-preview"

chmod +x "${REPO_DIR}/bin/hugo-mcp-server"

mkdir -p "$(dirname "${PLUGIN_DIR}")"
if [ -L "${PLUGIN_DIR}" ]; then
  rm "${PLUGIN_DIR}"
elif [ -e "${PLUGIN_DIR}" ]; then
  echo "Error: ${PLUGIN_DIR} already exists and is not a symlink. Remove it manually first." >&2
  exit 1
fi

ln -s "${REPO_DIR}" "${PLUGIN_DIR}"
echo "Installed plugin symlink: ${PLUGIN_DIR} -> ${REPO_DIR}"
