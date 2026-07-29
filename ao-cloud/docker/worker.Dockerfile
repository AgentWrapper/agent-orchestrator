# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/ao-worker ./cmd/ao-worker

FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client \
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
RUN ln -s /usr/local/bin/ao-worker /usr/local/bin/ao

USER ao
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ao-worker"]
