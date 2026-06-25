# Base image pulled through the user's cloudflare-docker-proxy so the build does
# not depend on auth.docker.io, which is unreliable from this host.
# To build against Docker Hub directly, swap this back to `node:22-slim`.
FROM docker.evilstarss.com/library/node:22-slim

WORKDIR /app

COPY package.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm install --omit=dev --no-audit --no-fund \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY index.js store.js ./

ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "index.js"]
