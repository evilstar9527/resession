# better-sqlite3 ships prebuilt binaries for node:22 on Debian. If a prebuild is
# missing for the platform, npm falls back to compiling from source, which needs
# python3/make/g++ — install them so the build never fails, then remove to keep
# the image small.
FROM node:22-slim

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
