#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
node cli/cf.ts tick >/dev/null 2>&1 &
