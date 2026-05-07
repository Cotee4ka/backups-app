# @backups-app/server

Node.js backend for the Backups App. Runs in Docker on an Ubuntu VPS.

## Features

- Fastify HTTP/HTTPS API with JWT auth (argon2id password hashing).
- WebSocket signaling channel (`/ws`) for project change notifications.
- Smart-HTTP git hosting (`/git/<projectId>.git/*`) backed by `git http-backend`.
- SQLite (`better-sqlite3`) for users, projects, audit log, invites.
- Self-signed TLS generated on first start; SHA-256 fingerprint exposed for client pinning.

## Endpoints (summary)


| Method | Path                    | Description                                                |
| ------ | ----------------------- | ---------------------------------------------------------- |
| `POST` | `/auth/register`        | Create user (owner via bootstrap token, others via invite) |
| `POST` | `/auth/login`           | Get JWT + refresh token                                    |
| `POST` | `/auth/refresh`         | Rotate the access token                                    |
| `GET`  | `/auth/me`              | Current user info                                          |
| `POST` | `/projects`             | Create project (also creates a bare git repo)              |
| `GET`  | `/projects`             | List projects the user is a member of                      |
| `GET`  | `/projects/:id`         | Project detail + members + head sha                        |
| `GET`  | `/projects/:id/commits` | Commit history                                             |
| `POST` | `/projects/:id/restore` | Roll back to a sha (revert or hard reset)                  |
| `POST` | `/projects/:id/tags`    | Create a named tag for a sha                               |
| `GET`  | `/projects/:id/audit`   | Audit log filtered by project                              |
| `POST` | `/invites`              | Create an invite token (owner/admin only)                  |
| `GET`  | `/status`               | Server status, disk usage                                  |
| `GET`  | `/healthz`              | Liveness probe                                             |
| `*`    | `/git/<id>.git/*`       | Smart-HTTP git transport (push/pull)                       |
| `WS`   | `/ws?token=<jwt>`       | Signaling socket                                           |


## Local development

```bash
cp .env.example .env
# Set BACKUPS_INSECURE=true for plain HTTP locally
pnpm install
pnpm --filter @backups-app/shared build
pnpm --filter @backups-app/server dev
```

Then register the first user:

```bash
curl -X POST http://localhost:8443/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"correct horse battery","bootstrapToken":"printed-by-install-script"}'
```

## Docker

The image `apps/server/Dockerfile` is built via `docker compose` (see the project root). It includes `git`, `openssl`, and Node 20.

## Environment variables

See `[.env.example](./.env.example)`.