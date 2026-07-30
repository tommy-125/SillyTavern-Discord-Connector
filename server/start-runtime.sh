#!/bin/sh
set -eu
cd "$(dirname "$0")"
echo "Checking dependencies..."
npm install
echo "Starting KuroHelper AI Runtime..."
node server.js
