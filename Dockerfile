# 1. Build the frontend. VITE_* values are baked into the JS at build time;
#    Railway passes service variables in as build args when they're declared here.
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_MAPTILER_KEY
RUN npm run build

# 2. Build the Go API with the frontend embedded.
FROM golang:1.27-alpine AS api
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/api ./cmd/api

# 3. Tiny runtime image (includes CA certificates for the HTTPS APIs).
FROM gcr.io/distroless/static-debian12
COPY --from=api /out/api /api
COPY features.yaml /features.yaml
ENV FEATURES_FILE=/features.yaml
# Only used when DATABASE_URL is unset; the image runs as a non-root user.
ENV DATA_DIR=/tmp/overnight
USER nonroot
ENTRYPOINT ["/api"]
