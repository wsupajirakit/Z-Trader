# Deploying zTraderActor on Coolify

> **Usually not needed.** The repository root's `docker-compose.yml` already runs the Actor next to
> zTraderService in one Coolify resource, with no domain of its own; the service dashboard drives it
> (Strategy page). See `zTraderService/docs/deploy.md`, "Deploying on Coolify". Use the steps below only
> to run the Actor as a separate application with its own public UI.

## 1. Create the resource

- In Coolify, open your project and add an **Application** from your Git repository.
- **Build pack:** `Dockerfile`, with the repository root as the build context.
- **Port:** `3000` (or whatever you set `PORT` to).
- **Domain:** set your public URL, e.g. `https://ztrader-actor.example.com`. Coolify/Traefik terminates TLS.
- **Instances:** keep it at **1**. Sessions live in memory, so a second replica wouldn't know the first
  replica's logins. Every redeploy or restart logs all users out.

## 2. Environment variables

Set these in the application's **Environment Variables** tab. The image never contains a `.env` file,
because `.dockerignore` excludes it.

| Variable         | Value                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `API_TRADER_URL` | zTraderService URL on the internal Docker network, e.g. `http://ztrader-service:6500` |
| `API_KEY`        | Same machine key as zTraderService's `API_KEY` (at least 32 characters)               |
| `TRUST_PROXY`    | `1` (Traefik is one hop). Without it, HTTPS cookies and client IPs are wrong          |
| `PORT`           | `3000`                                                                                |

The legacy strategy loop also reads `SYMBOL`, `STRATEGY_MODE`, `MAX_POSITIONS`, `TRADE_LOT_SIZE` and
`TRADE_AMOUNT_USD`. They are optional; see the README. zTraderService decides which cTrader account
(demo or live) trades, so the Actor has no account settings.

Don't add cTrader tokens, `MONGO_URI`, Telegram tokens or app secrets here. They belong to zTraderService,
and this app doesn't use them.

If the app is misconfigured, it exits at boot and lists every invalid variable in the deployment log.

## 3. Health check

The image has a Docker `HEALTHCHECK`. If Coolify asks for one too, use:

- **Method:** `GET`
- **Path:** `/health` (no auth; returns `{"status":"ok"}`)

## 4. Users

Accounts are managed on the main zTraderService dashboard. Log in to the Actor with the same username and
password. New or reset accounts must change their password on the main dashboard before the Actor accepts
them. Only `operator` and `admin` can trade or change settings. `viewer` is read-only.
A disable, role change or password reset made on the main dashboard reaches the Actor within 60 s. If
zTraderService is unreachable, logged-in users keep read access but can't trade until it is back.

> [!IMPORTANT]
> zTraderService must be reachable from this container. On the same Coolify server, use the internal service
> name instead of the public URL, and don't expose zTraderService's machine API publicly unless you need to.
