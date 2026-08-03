# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -trimpath -ldflags="-s -w" -o /out/ao-worker ./cmd/ao-worker \
    && CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -trimpath -ldflags="-s -w" -o /out/ao ./cmd/ao-cloud-agent

FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gosu jq openssh-client python3 \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /bin/bash ao \
    && mkdir -p /workspace /home/ao/.ao/worker \
    && chown -R ao:ao /workspace /home/ao

USER ao
ENV HOME=/home/ao
ENV AO_DATA_DIR=/home/ao/.ao/worker
ENV AO_WORKSPACE_DIR=/workspace/repository
ENV PATH=/home/ao/.local/bin:/home/ao/.claude/bin:${PATH}

# Build the reusable worker image with all V1 coding-agent CLIs. Authentication
# is injected later through the AO credential broker, never baked into this layer.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && curl -fsSL https://chatgpt.com/codex/install.sh | sh \
    && curl -fsS https://cursor.com/install | bash \
    && claude --version \
    && codex --version \
    && cursor-agent --version

USER root
COPY --from=build /out/ao-worker /usr/local/bin/ao-worker
COPY --from=build /out/ao /usr/local/bin/ao
COPY ao-cloud/docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
COPY ao-cloud/docker/worker-gh-wrapper.sh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/worker-entrypoint /usr/local/bin/ao /usr/local/bin/gh

USER root
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
