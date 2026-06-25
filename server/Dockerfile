# Base image pulled through the user's cloudflare-docker-proxy so the build does
# not depend on auth.docker.io, which is unreliable from this host.
# To build against Docker Hub directly, swap this back to `node:22-slim`.
FROM docker.evilstarss.com/library/node:22-slim

WORKDIR /app

# curl is needed by Coolify's container healthcheck (slim images omit it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# better-sqlite3 is an OPTIONAL dependency. We try a prebuilt-only install (no
# native compile, no apt toolchain) so the build stays fast and offline-friendly.
# If the prebuilt binary isn't available, the server transparently falls back to
# a zero-dependency JSON index (see store.js) — no functionality is lost for the
# small-team scale this serves.
ENV npm_config_build_from_source=false
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --omit=optional --no-audit --no-fund

COPY index.js store.js ./

ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["node", "index.js"]
