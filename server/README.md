# resession-server

A thin sync server for [resession](../README.md): stores Claude/Codex session
metadata + raw JSONL so you can view your sessions across devices.

It is deliberately dumb: it does not parse JSONL. Clients parse locally and upload
metadata + the raw file + a content hash. The server stores metadata in SQLite
(falling back to a JSON index if the native module is unavailable) and the JSONL
blobs on disk under `DATA_DIR`.

## Run with Docker

```bash
docker build -t resession-server .
docker run -d --name resession-server \
  -e RESESSION_TOKEN=your-long-random-token \
  -p 8080:8080 \
  -v /srv/resession-data:/data \
  resession-server
```

Then on each machine:

```bash
resession login https://your-host test-token --device my-laptop
resession push
```

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `RESESSION_TOKEN` | *(required)* | Shared bearer token; clients must send `Authorization: Bearer <token>` |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | Where SQLite index + JSONL blobs live (mount a volume) |
| `MAX_BODY_BYTES` | `268435456` (256MB) | Max single-session upload size |

## Deploying on Coolify

1. New resource → Docker / Dockerfile, point at this `server/` directory.
2. Set env var `RESESSION_TOKEN` (a long random string).
3. Add a **persistent volume** mounted at `/data`.
4. Expose port `8080`, bind a domain, enable TLS.
5. Health check path: `/healthz`.

## API

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | no | health check |
| `GET /sessions` | yes | list all metadata (`?device=&source=&since=`) |
| `GET /sessions/:device/:source/:id` | yes | fetch one session's JSONL |
| `PUT /sessions/:device/:source/:id` | yes | upload one (body=JSONL, meta in `x-*` headers) |
| `POST /sync/diff` | yes | given `{entries:{key:hash}}`, returns `{needUpload:[...]}` |
