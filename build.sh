#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ ! -x node_modules/.bin/tsc ] || [ ! -d node_modules/typescript ] || [ ! -d node_modules/@types/node ]; then
	echo "Installing Node.js dependencies for build..." >&2
	npm install --include=dev
fi

exec npm run build
