# Control-plane image. Build context MUST be the backend module root:
#   docker build -f deploy/controlplane/Dockerfile -t ao-controlplane .
#
# It bakes TWO binaries:
#   - controlplane  : the hosted service
#   - ao-linux      : the cross-compiled linux `ao` the control plane uploads
#                     into each Daytona sandbox (AO_LINUX_BINARY points at it)
# so the image is self-contained — no external binary to mount at runtime.
FROM golang:1.25 AS build
WORKDIR /src

# Cache deps first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Static, CGO-free builds (matches the repo's release build; pure-Go sqlite/pgx).
ENV CGO_ENABLED=0
RUN go build -trimpath -o /out/controlplane ./cmd/controlplane
# The linux/amd64 `ao` binary uploaded into sandboxes.
RUN GOOS=linux GOARCH=amd64 go build -trimpath -o /out/ao-linux ./cmd/ao

# Distroless static: minimal, includes CA certs for outbound HTTPS (Daytona + Clerk JWKS).
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/controlplane /app/controlplane
COPY --from=build /out/ao-linux /app/ao-linux
ENV AO_LINUX_BINARY=/app/ao-linux
ENV CONTROLPLANE_ADDR=:8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/controlplane"]
