# syntax=docker/dockerfile:1
# AO agent sandbox snapshot for the Daytona runtime adapter
# (backend/internal/adapters/runtime/daytona; design: docs/cloud/daytona-runtime.md).
#
# Bakes in everything the adapter and a real agent session need, so nothing is
# apt-installed at runtime:
#   - tmux        the in-sandbox terminal runtime (attach/scrollback/send-keys)
#   - git         workspace clone + preserve-ref operations
#   - procps      `ps` for the supervised-process liveness walk (issue #2802)
#   - node + Claude Code CLI   the agent harness
#   - ao          this repo's CLI (built from source in stage 1) so agent hook
#                 commands (`ao hooks …`) resolve; they reach the calling
#                 daemon via AO_API_BASE/AO_API_TOKEN injected at sandbox boot
#
# Build from the REPO ROOT (the ao build stage copies backend/):
#   docker build --platform linux/amd64 \
#     -f test/daytona-snapshot/Dockerfile -t ao-agent-sandbox:<version> .
#
# Daytona requires amd64 images with a pinned tag (no :latest). Push either
# with the Daytona CLI (builds/uploads the local image):
#   daytona snapshot push ao-agent-sandbox:<version> --name ao-agent-sandbox:<version>
# or through a registry:
#   docker tag ao-agent-sandbox:<version> ghcr.io/<org>/ao-agent-sandbox:<version>
#   docker push ghcr.io/<org>/ao-agent-sandbox:<version>
#   daytona snapshot create ao-agent-sandbox:<version> --image ghcr.io/<org>/ao-agent-sandbox:<version>
#
# Then run the live demo:
#   DAYTONA_API_KEY=… AO_DAYTONA_SNAPSHOT=ao-agent-sandbox:<version> \
#   AO_DAYTONA_AGENT_ARGV='["claude","-p","say hello"]' CLAUDE_CODE_OAUTH_TOKEN=… \
#   go test ./internal/adapters/runtime/daytona/ -run TestLive -v   # from backend/

FROM golang:1.25-bookworm AS ao-build
WORKDIR /src
COPY backend/ ./backend/
# Pure-Go build (modernc sqlite): CGO off keeps the binary portable across the
# snapshot's glibc without needing build toolchains in the final image.
RUN cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ao ./cmd/ao

FROM node:22-bookworm-slim

# Pin the agent CLI at build time for reproducible snapshots:
#   docker build --build-arg CLAUDE_CODE_VERSION=<x.y.z> …
# The default "latest" is fine for smoke; pin for production snapshots.
ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux git procps curl ca-certificates ripgrep locales sudo openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
    && locale-gen

# tmux -u is forced by the adapter's attach, but a real UTF-8 locale keeps
# every other tool (git, node, agent CLIs) from mangling non-ASCII output.
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

COPY --from=ao-build /out/ao /usr/local/bin/ao

# Daytona's default sandbox user convention: `daytona`, home /home/daytona —
# the adapter's default WorkspaceRoot (/home/daytona/ao) assumes it. Passwordless
# sudo mirrors Daytona's stock images so operators can debug interactively.
RUN useradd -m -s /bin/bash daytona \
    && echo "daytona ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/daytona \
    && chmod 0440 /etc/sudoers.d/daytona

USER daytona
WORKDIR /home/daytona

# Daytona supplies its own sandbox supervisor/entrypoint; this is only the
# fallback when the image is run outside Daytona (e.g. local docker smoke).
CMD ["sleep", "infinity"]
