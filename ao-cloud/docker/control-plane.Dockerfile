# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ao-cloud ./cmd/ao-cloud \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ao-worker ./cmd/ao-worker

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ao-cloud /usr/local/bin/ao-cloud
COPY --from=build /out/ao-worker /usr/local/bin/ao-worker
ENV AO_WORKER_BINARY_PATH=/usr/local/bin/ao-worker
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/ao-cloud"]

# Local Docker sandboxes are managed through the Docker CLI. This target is
# used only by docker-compose.local.yml with the host Docker socket mounted.
FROM docker:27-cli AS local
COPY --from=build /out/ao-cloud /usr/local/bin/ao-cloud
COPY --from=build /out/ao-worker /usr/local/bin/ao-worker
ENV AO_WORKER_BINARY_PATH=/usr/local/bin/ao-worker
ENTRYPOINT ["/usr/local/bin/ao-cloud"]
