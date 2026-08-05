#!/bin/sh
set -eu

mkdir -p /workspace /home/ao/.ao/worker
chown ao:ao /workspace

exec gosu ao /usr/local/bin/ao-worker
