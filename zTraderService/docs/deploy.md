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
dc build service                 # add --pull to refresh node:26-alpine for security fixes
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

## Deploying on Coolify (one deployment, one domain)

The repository root holds a compose file made for Coolify: [`docker-compose.yml`](../../docker-compose.yml). It
builds and runs the whole stack from one resource:

| Service | Built from | Public | Role |
|---|---|---|---|
| `service` | `zTraderService/` (API + dashboard in one image) | **the only domain**, port 6500 | trading service, dashboard, REST + SSE |
| `mongo` | `zTraderService/docker/mongo/` (mongo:8 + app-user init script) | no | database, on an internal network only |
| `actor` | `zTraderActor/` | no | legacy strategy loop, driven from the dashboard's Strategy page |

The browser only ever talks to the one domain: the dashboard, `/api/*` and the chart's Server-Sent Events are
all served by `service`. No port is published on the server. Coolify's proxy (Traefik) reaches `service`
over the resource network.

### Steps

1. **New resource** → your Git repository and branch → build pack **Docker Compose**. Base directory `/`,
   compose file `/docker-compose.yml`.
2. **Environment variables.** Coolify generates these on the first deploy and keeps them; leave them alone:
   `SERVICE_PASSWORD_64_MONGOROOT`, `SERVICE_PASSWORD_64_MONGOAPP` (database passwords, letters and digits
   only, so they are safe in the MongoDB URI), `SERVICE_HEX_64_APIKEY` (machine API key shared by `service`
   and `actor`) and `SERVICE_URL_SERVICE_6500` (the generated domain). Set these yourself:

   | Variable | Required | Value |
   |---|---|---|
   | `APP_ID`, `APP_SECRET`, `ACCESS_TOKEN` | yes | cTrader Open API application and access token |
   | `DEMO_ACCOUNT_ID` | yes for DEMO | cTrader account id (`LIVE_ACCOUNT_ID` for LIVE) |
   | `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` | first deploy | first admin; delete both after the first start and redeploy |
   | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | no | AI layer (TA only without them) |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | notifications |
   | `TV_AUTH_TOKEN` or `TV_USERNAME` / `TV_PASSWORD` | no | TradingView sign-in for chart data |
   | `CTRADER_ACCOUNT_MODE`, `CTRADER_ALLOW_LIVE` | no | stay `DEMO` / `false` until you mean real money (see below) |

   `TRUST_PROXY=1` is fixed in the compose file: Traefik is one hop in front, so the app sees HTTPS, issues the
   `__Host-` Secure session cookie and logs real client IPs. A missing required value stops the deploy with
   the variable's name.
3. **Domain.** Coolify fills the domain of `service` from `SERVICE_URL_SERVICE_6500`. To use your own, set it
   on `service` in the Domains section as `https://trader.example.com:6500` (the `:6500` is the container
   port; visitors use plain HTTPS). Give no domain to `mongo` or `actor`.
4. **Build options.** Turn on *Include Source Commit in Build*. The commit is then recorded with every
   analysis round and order (`APP_COMMIT`).
5. **Deploy.** The log should show `zTrader ready on :6500 (DEMO, production)`. Then check:

   ```bash
   curl -fsS https://trader.example.com/health/ready                                       # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' https://trader.example.com/api/dashboard/status # 401
   ```

   Sign in with the bootstrap admin, delete `BOOTSTRAP_ADMIN_*` in Coolify and redeploy.

### Notes

- **Persistence.** The named volumes `mongo-data`, `mongo-config`, `archive` (every analysis round) and
  `data` (dashboard settings, risk profile marker, order log) survive redeploys. Coolify prefixes them with
  the resource id. Don't delete them, and schedule backups (see above).
- **Start order.** `mongo` must be healthy (its healthcheck logs in as the app user) before `service` starts,
  and `service` must be healthy before `actor` starts. Health comes from the images' own checks
  (`/health/ready` = HTTP up and MongoDB answering).
- **One replica.** The trading loop and the cTrader socket are single-instance. Never scale `service`.
- **Shutdown.** Coolify sends SIGTERM; `tini` passes it on and `stop_grace_period: 30s` lets Nest close the
  cTrader socket and MongoDB.
- **Hardening.** `service` and `actor` run as the `node` user on read-only root filesystems with every Linux
  capability dropped; `mongo` sits on an internal network with no route out.
- **Not on Coolify?** Run `zTraderService/docker-compose.yml` with an `.env.compose` instead (see
  [Local quick start](#local-quick-start)); it publishes the ports on 127.0.0.1 and starts the actor only
  with `--profile actor`.

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

- Multi-stage build on `node:26-alpine`. The runtime image contains only `dist/`, `web/dist/`, `proto/`,
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
