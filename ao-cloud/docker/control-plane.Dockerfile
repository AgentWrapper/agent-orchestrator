# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ao-cloud ./cmd/ao-cloud

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ao-cloud /usr/local/bin/ao-cloud
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/ao-cloud"]
