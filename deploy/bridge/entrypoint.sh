#!/bin/sh
set -eu

mkdir -p "${CONNECTOR_DATA_DIR:-/data}"
chown -R node:node "${CONNECTOR_DATA_DIR:-/data}"

exec su-exec node "$@"
