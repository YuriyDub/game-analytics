# Game Analytics

Self-hosted, privacy-friendly analytics for web games on **itch.io** (or any site
that can load a script). One small Node.js server does everything:

- **`/gg.js`** — a ~2 KB tracking SDK your game loads. Tracks sessions, playtime
  (via heartbeats), browser/OS, referrer, and any custom events you send with
  `GG.track("level_complete", { level: 3 })`.
- **`/api/collect`** — the ingestion endpoint (CORS-open, since itch.io serves
  games from `html.itch.zone`).
- **`/`** — a password-protected dashboard: players, sessions, median playtime,
  activity-per-day chart, top events, browser/OS/referrer breakdowns, recent
  sessions. Supports multiple games.

Storage is SQLite via [libSQL](https://github.com/tursodatabase/libsql): a
single local file by default (no external database to run), or a hosted
[Turso](https://turso.tech) database when `TURSO_DATABASE_URL` is set — which
makes hosts with ephemeral disks (like Render's free tier) viable. No cookies,
no IP storage, anonymous player IDs; safe to use without a consent banner in
most setups (verify for your jurisdiction).

## Quick start

```sh
npm install
ADMIN_PASSWORD=pick-a-password npm start
# open http://localhost:3000
```

Create a game in the dashboard; it gives you the exact snippet to paste.

## Adding it to your itch.io game

1. In your HTML5 build, open `index.html` and add **before** your game script:

   ```html
   <script src="https://YOUR-ANALYTICS-HOST/gg.js" data-game="GAME_ID"></script>
   ```

2. Re-zip the build and upload it to itch.io as usual.
3. Optionally, track gameplay events from your game code (works from any engine
   that can call JS — for Godot use `JavaScriptBridge.eval`, for Unity a `.jslib`
   plugin, for Construct/GDevelop a JS block):

   ```js
   GG.track("level_complete", { level: 3, deaths: 1 });
   GG.track("game_over");
   ```

Notes for itch.io specifically:

- Session start, playtime heartbeats, and page-hide flushes (`sendBeacon`) are
  automatic — you get sessions/players/playtime with zero extra code.
- itch.io sandboxes games in an iframe. If storage is blocked, the SDK falls
  back to a per-session anonymous ID automatically.
- Your analytics host **must be HTTPS** (itch.io pages are HTTPS; browsers block
  mixed content). Every hosting option below gives you HTTPS out of the box.

## Configuration

| Env var | Meaning |
|---|---|
| `ADMIN_PASSWORD` | **Required.** Dashboard password. |
| `SECRET` | HMAC key for login cookies. Set it (e.g. `openssl rand -hex 32`) or logins reset on restart. |
| `PORT` | Default `3000`. |
| `DATA_DIR` | Where the local `analytics.db` lives. Default `./data`. Ignored when `TURSO_DATABASE_URL` is set. |
| `TURSO_DATABASE_URL` | Optional. A `libsql://…` URL of a [Turso](https://turso.tech) database; use it on hosts without a persistent disk. |
| `TURSO_AUTH_TOKEN` | Auth token for the Turso database. |

## Hosting options

The app is one Node process + one SQLite file, so it wants a host with a
**persistent disk** — or, on hosts without one, a hosted
[Turso](https://turso.tech) database (option 0 below).

### 0. Render free tier + Turso — $0

Render's free web services have no persistent disk (local data is wiped on
every deploy and idle spin-down), so point the app at Turso's free tier
instead:

```sh
# once, locally:
brew install tursodatabase/tap/turso   # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create game-analytics
turso db show game-analytics --url     # -> TURSO_DATABASE_URL
turso db tokens create game-analytics  # -> TURSO_AUTH_TOKEN
```

Set both values (plus `ADMIN_PASSWORD` / `SECRET`) in the Render service's
environment and redeploy. Free-tier spin-downs still add a 30–60 s cold start
after idle periods, but data now survives them.

### 1. Fly.io — best fit (~$2–3/mo, can be less)

Runs a tiny VM close to your players, persistent volume for SQLite, free TLS.

```sh
fly launch --no-deploy          # detects the Dockerfile
fly volumes create data --size 1
fly secrets set ADMIN_PASSWORD=... SECRET=$(openssl rand -hex 32)
fly deploy
```

Add to the generated `fly.toml`:

```toml
[mounts]
  source = "data"
  destination = "/data"
```

### 2. Railway (~$5/mo) or Render (paid disk)

Push the repo to GitHub, click "new service from repo" — both detect the
Dockerfile. Attach a **volume** (Railway) or **persistent disk** (Render, paid
plans) mounted at `/data`, and set the env vars in the UI. Easiest workflow if
you want zero CLI. Note: Render's free tier has no disk **and** spins down on
idle — pair it with Turso (option 0) or use a paid instance there.

### 3. Any VPS — cheapest at scale (Hetzner ~€4/mo, DigitalOcean $6/mo)

```sh
docker build -t game-analytics .
docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v /srv/analytics-data:/data \
  -e ADMIN_PASSWORD=... -e SECRET=... game-analytics
```

Put [Caddy](https://caddyserver.com) in front for automatic HTTPS —
`Caddyfile`: `analytics.example.com { reverse_proxy localhost:3000 }`.
Most control, and one VPS can host many other things too.

### 4. Free-tier serverless (Cloudflare Workers + D1) — requires a rewrite

Cloudflare's free tier (100k requests/day, D1 SQLite) would host this for $0,
but Express doesn't run on Workers — the server would need a port to Hono + D1
bindings. The Render + Turso combo (option 0) gets to $0 with no rewrite.

**Recommendation:** Fly.io if you like the CLI, Railway if you want click-ops,
Hetzner VPS if you already run one. Whatever you pick, back up
`/data/analytics.db` occasionally (it's a single file — `scp` works, or
`sqlite3 analytics.db ".backup backup.db"` for a consistent copy).

## API sketch

- `POST /api/collect` — `{ game, session, player, meta, events: [{name, props?}] }` (public, rate-limited)
- `POST /api/login` / `POST /api/logout`
- `GET /api/games` · `POST /api/games` · `DELETE /api/games/:id` (auth)
- `GET /api/games/:id/stats?days=30` (auth)
