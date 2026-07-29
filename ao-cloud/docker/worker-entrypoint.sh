#!/bin/sh
set -eu

mkdir -p /workspace /home/ao/.ao/worker
chown -R ao:ao /workspace /home/ao

exec gosu ao /usr/local/bin/ao-worker
