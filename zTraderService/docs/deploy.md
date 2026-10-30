# Deploying zTraderService with Docker

The stack in `docker-compose.yml` (project name `ztrader`):

| Service   | Image                          | Network       | Published port         | Notes                                                   |
| --------- | ------------------------------ | ------------- | ---------------------- | ------------------------------------------------------- |
| `mongo`   | `mongo:8`                      | `db` (internal) | none                 | auth on, app user has `readWrite` on the app DB only    |
| `service` | built from `Dockerfile`        | `db` + `edge` | `127.0.0.1:6500` | API + dashboard, read-only root FS, non-root, no capabilities |
| `actor`   | built from `../zTraderActor`   | `edge`        | `127.0.0.1:3000` | optional, `--profile actor`. Has no route to MongoDB.   |

`db` is an `internal` network, so it has no route to the host or the internet. MongoDB is reachable only from `service`.

Volumes: `mongo-data` and `mongo-config` (database), `archive` (`/app/archive`, the per-round JSON history) and
`data` (`/app/data`: `runtime-settings.json`, the risk settings saved from the dashboard, plus `order.log`).

## Local quick start

Requirements: Docker Engine 24+ with Compose v2 (Docker Desktop is fine).

```bash
cp .env.compose.example .env.compose
# fill in the three required secrets (next section) and the first admin
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps          # mongo and service should be "healthy"
open http://127.0.0.1:6500
```

Always pass `--env-file .env.compose`. Without it, compose falls back to `.env`, which is the config for
running Node directly. Because the required secrets aren't in `.env`, compose stops with an error instead of
starting. To save typing:

```bash
alias dc='docker compose --env-file .env.compose'
```

> [!WARNING]
> Variables exported in your shell take precedence over the env file during interpolation. If your shell
> has, for example, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` exported, the container gets them. Check with
> `docker compose --env-file .env.compose config` before the first `up`.

`.env.compose` contains real secrets. Never commit it. The repo's `.gitignore` already ignores
`.env.*`, except the `*.example` files.

With zTraderActor (the sibling repo must be checked out next to this one, or set `ACTOR_CONTEXT`):

```bash
docker compose --env-file .env.compose --profile actor up -d --build
open http://127.0.0.1:3000
```

The actor calls `http://service:6500` over the internal network with the same `API_KEY`. The service in turn
calls the actor at `ACTOR_URL` (compose default `http://actor:3000`) for the dashboard's Strategy page; without
the `actor` profile that page just reports "Actor unreachable".

Other useful commands:

```bash
dc logs -f service               # follow the app log
dc restart service               # restart, keeps all data
dc down                          # stop and remove containers, KEEPS volumes
dc down -v                       # also DELETES the database and archive volumes
```

The ports bind to `127.0.0.1` by default. Set `HTTP_BIND=0.0.0.0` to open them to your LAN, and
`HTTP_PORT` / `ACTOR_PORT` to change the host ports.

## Generating secrets

Every secret is 32 random bytes in hex. Hex is URL-safe, which matters because the Mongo password is embedded in `MONGO_URI`:

```bash
for v in API_KEY MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD; do echo "$v=$(openssl rand -hex 32)"; done
```

| Variable              | Required | Used by                                                                 |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `API_KEY`             | yes      | machine API key (zTraderActor, scripts). The app refuses fewer than 32 chars |
| `MONGO_ROOT_PASSWORD` | yes      | the mongo root user. Admin tasks and backups only, never the app        |
| `MONGO_APP_PASSWORD`  | yes      | the `ztrader` user the app connects as                                  |

If one of them is missing, compose stops with a message like
`required variable MONGO_APP_PASSWORD is missing a value`.

The image itself contains no secrets. `.dockerignore` keeps every `.env*` file out of the build context,
and all secrets are injected at runtime as environment variables.

## The first admin

On the first start, when the `users` collection is empty, the app creates an admin from
`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`. The username is 3-32 chars of `a-z 0-9 . _ -`,
and the password is at least 9 chars.

1. Set both in `.env.compose` and start the stack. The log shows
   `created bootstrap admin "<name>" — remove BOOTSTRAP_ADMIN_* from the environment now`.
2. Log in at `/`, then create the real users on the Users page.
3. Remove both variables from `.env.compose` and run `dc up -d` to apply.

Recovery or extra users from the CLI. The password is read from the terminal, not from the arguments:

```bash
dc exec service node dist/cli/create-user.js --username alice --role admin
```

The image has no `npm`, so call `node dist/cli/create-user.js` directly instead of `npm run user:create`.

## Backups

The database (as root, which can read everything; the dump goes to a file on the host):

```bash
dc exec -T mongo sh -c 'mongodump --quiet --archive --gzip \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --db "$MONGO_APP_DB"' > "ztrader-$(date +%Y%m%d-%H%M).archive.gz"
```

Restore (this replaces the app database's collections):

```bash
dc exec -T mongo sh -c 'mongorestore --quiet --archive --gzip --drop \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --nsInclude "$MONGO_APP_DB.*"' < ztrader-YYYYMMDD-HHMM.archive.gz
```

The `data` and `archive` volumes:

```bash
docker run --rm -v ztrader_data:/v:ro -v "$PWD":/backup alpine tar czf /backup/data.tgz -C /v .
docker run --rm -v ztrader_archive:/v:ro -v "$PWD":/backup alpine tar czf /backup/archive.tgz -C /v .
```

Credentials are expanded inside the mongo container, so they never show up in your shell history.
Store the dumps somewhere other than the Docker host.

## Upgrades

```bash
git pull
dc build service                 # add --pull to refresh node:24-alpine for security fixes
dc up -d                         # recreates only what changed; volumes are kept
dc ps && curl -fsS http://127.0.0.1:6500/health/ready
```

- Take a database backup first.
- To roll back, check out the previous commit and run `dc up -d --build` again. To keep the old image
  around instead, build with a tag, for example `IMAGE_TAG=$(git rev-parse --short HEAD)`.
- Image metadata: `IMAGE_VERSION` and `GIT_REVISION` become OCI labels, visible with
  `docker image inspect ztrader-service:local`.
- `mongo:8` follows 8.x minor releases. Before moving to a new major version (9), back up, read the
  MongoDB upgrade notes, and check `featureCompatibilityVersion`.

### Rotate the database password

`docker/mongo/init-app-user.js` runs only when the `mongo-data` volume is empty. Changing
`MONGO_APP_PASSWORD` later does not change the user. Change it in MongoDB first, then in the env:

```bash
export NEW_PW=$(openssl rand -hex 32)
dc exec -T -e NEW_PW mongo sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --eval "db.getSiblingDB(process.env.MONGO_APP_DB).changeUserPassword(process.env.MONGO_APP_USER, process.env.NEW_PW)"'
# put the same value in MONGO_APP_PASSWORD in .env.compose, then:
dc up -d && unset NEW_PW
```

`dc up -d` recreates `mongo` (its healthcheck uses the new password) and `service` (new `MONGO_URI`).
The root password works the same way:
`db.getSiblingDB("admin").changeUserPassword(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.NEW_PW)`,
then update `MONGO_ROOT_PASSWORD`.

## Deploying on Coolify ("Docker Compose" build pack)

1. **New resource**: choose your Git repository, branch, and build pack **Docker Compose**. Leave the
   base directory as `/` and the compose file as `/docker-compose.yml`.
2. **Environment variables** (resource, then Environment Variables). Coolify lists every `${VAR}` from the
   compose file, and marks the `${VAR:?…}` ones as required. Set:
   - `API_KEY`, `MONGO_ROOT_PASSWORD`, `MONGO_APP_PASSWORD`, generated as above
   - `TRUST_PROXY=1`, because Traefik is one hop in front. Without it the app doesn't see HTTPS, the
     session cookie isn't marked Secure, and client IPs in the audit log are Traefik's
   - `SESSION_COOKIE_SECURE=auto` (the default). Behind HTTPS this gives the `__Host-` Secure cookie
   - `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` for the first deploy only, then delete them
   - the cTrader values (`APP_ID`, `APP_SECRET`, `ACCESS_TOKEN`, `DEMO_ACCOUNT_ID`, …) and optional
     `TELEGRAM_*` / `GEMINI_API_KEY`

   Coolify writes these into the deployment's env file itself, so there's no `--env-file` step.
3. **Domain**: assign a domain **only to `service`**, with the container port, e.g.
   `https://trader.example.com:6500`. Don't give `mongo` a domain. Give `actor` one only if you run it
   (e.g. `https://actor.example.com:3000`).
4. **Storage**: the named volumes (`mongo-data`, `mongo-config`, `archive`, `data`) persist across
   redeploys. Coolify prefixes them with the resource ID. Don't delete them when you redeploy, and set up
   the backups above, or Coolify's scheduled backups, for the database.
5. **Deploy**, then check the deployment log for `zTrader ready on :6500 (DEMO, production)`, and verify:

   ```bash
   curl -fsS https://trader.example.com/health/ready                                      # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' https://trader.example.com/api/dashboard/status # 401
   ```

Notes:

- The compose `ports:` entry binds to `127.0.0.1` on the server, so it is not public. Traefik reaches
  the container over Coolify's network. If another app on the same server already uses host port 6500,
  set `HTTP_PORT` to a free port.
- The actor is behind a compose profile, so a normal deploy does not start it. To run it, set
  `COMPOSE_PROFILES=actor`, and make sure the build can see the zTraderActor source (`ACTOR_CONTEXT`). On
  Coolify it's usually simpler to deploy zTraderActor as its own resource and point its `API_TRADER_URL`
  at this service.
- `docker/mongo/init-app-user.js` is bind-mounted from the repository checkout, which Coolify supports
  for compose deployments. It runs only on the first deploy, when the database volume is still empty.
- Keep the service at one replica. The trading loop and the cTrader socket are single-instance by
  design.
- Coolify stops containers with SIGTERM. `tini` passes it to Node, and `stop_grace_period: 30s` gives Nest
  time to close the cTrader socket and Mongo.

## Enabling LIVE trading (real money)

LIVE needs **both** switches. With only one of them set, the app refuses to boot:

```
Invalid environment:
  - CTRADER_ACCOUNT_MODE=LIVE also requires CTRADER_ALLOW_LIVE=true (real money safety interlock)
```

1. Run on DEMO first, and confirm that orders, risk limits and the daily stop behave as expected.
2. Set `LIVE_ACCOUNT_ID` and an `ACCESS_TOKEN` that is authorised for the live account.
3. Set both:

   ```bash
   CTRADER_ACCOUNT_MODE=LIVE
   CTRADER_ALLOW_LIVE=true
   ```

4. Apply with `dc up -d` (or redeploy on Coolify). The log line and the dashboard badge should both say
   `LIVE`.
5. Check the risk settings on the dashboard before starting the loop. Values saved from the dashboard
   persist in the `data` volume and take precedence over the environment.

To go back to DEMO, set `CTRADER_ACCOUNT_MODE=DEMO` (or remove both variables) and run `dc up -d`.

## Security properties of the image and stack

- Multi-stage build on `node:24-alpine`. The runtime image contains only `dist/`, `web/dist/`, `proto/`,
  `package.json` and production `node_modules`. It has no sources, dev dependencies, npm/yarn or npm cache.
- The app runs as `node` (uid 1000). Its code is owned by root, so the process can't modify it. Only
  `/app/archive`, `/app/data` and a `/tmp` tmpfs are writable (`read_only: true`).
- `cap_drop: ALL` and `no-new-privileges` on `service` and `actor`.
- The `HEALTHCHECK` probes `/health/ready`, which pings MongoDB, so the container shows as unhealthy
  while the database is down.
- MongoDB has auth on and no published port, and sits on an internal network. The app's user can't read
  `admin`, other databases, or manage users.
- Container logs rotate (json-file, 5 × 10 MB per container).

## Troubleshooting

| Symptom                                                  | Cause / fix                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `required variable … is missing a value`                 | `--env-file .env.compose` missing, or the secret is empty                                     |
| `service` waits forever on `mongo`                       | `dc logs mongo`. Usually `MONGO_APP_*` changed after the volume was created (see Rotate)      |
| `Authentication failed` in the app log                   | `MONGO_APP_PASSWORD` no longer matches the user inside the volume (see Rotate)                |
| login works on http://127.0.0.1 but not behind the proxy | set `TRUST_PROXY=1`                                                                           |
| `dashboard bundle not found`                             | the image was built without `web/` (check `.dockerignore`)                                    |
| a tuning variable seems ignored                          | compose passes it only when it's set. Uncomment it in `.env.compose`, then run `dc up -d`     |
