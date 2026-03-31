#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
	echo "node is required but was not found on PATH." >&2
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "npm is required but was not found on PATH." >&2
	exit 1
fi

exec npm install --include=dev
