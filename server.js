import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGame,
  deleteGame,
  gameStats,
  getGame,
  listGames,
  recordBatch,
} from "./src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SECRET || randomBytes(32).toString("hex");

if (!ADMIN_PASSWORD) {
  console.warn(
    "WARNING: ADMIN_PASSWORD is not set — the dashboard is locked. Set it to log in."
  );
}
if (!process.env.SECRET) {
  console.warn("NOTE: SECRET not set — sessions reset on restart.");
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

// ---------- auth ----------
const sign = (v) => createHmac("sha256", SECRET).update(v).digest("base64url");

function makeToken() {
  const payload = `${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() - Number(payload) < 30 * 86400_000; // 30 days
}

function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const isAuthed = (req) => validToken(getCookie(req, "ga_auth"));

// Express 4 doesn't catch async handler rejections — route them to the error
// middleware instead of crashing the process.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/api/login", (req, res) => {
  const pw = String(req.body?.password || "");
  const ok =
    ADMIN_PASSWORD &&
    pw.length === ADMIN_PASSWORD.length &&
    timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: "wrong password" });
  res.setHeader(
    "Set-Cookie",
    `ga_auth=${makeToken()}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`
  );
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "ga_auth=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// ---------- event collection (public, CORS open — games live on itch.zone) ----------
const collectCors = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
};

// crude per-IP limiter: 120 collect calls/minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

function parseUA(ua = "") {
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /opr\//i.test(ua)
      ? "Opera"
      : /firefox\//i.test(ua)
        ? "Firefox"
        : /chrome\//i.test(ua)
          ? "Chrome"
          : /safari\//i.test(ua)
            ? "Safari"
            : "Other";
  const os = /windows/i.test(ua)
    ? "Windows"
    : /android/i.test(ua)
      ? "Android"
      : /iphone|ipad|ios/i.test(ua)
        ? "iOS"
        : /mac os/i.test(ua)
          ? "macOS"
          : /linux/i.test(ua)
            ? "Linux"
            : "Other";
  return { browser, os };
}

app.options("/api/collect", collectCors);
app.post("/api/collect", collectCors, ah(async (req, res) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 120) return res.status(429).json({ error: "rate limited" });

  const { game, session, player, meta = {}, events } = req.body || {};
  if (
    typeof game !== "string" ||
    typeof session !== "string" ||
    typeof player !== "string" ||
    !Array.isArray(events) ||
    session.length > 64 ||
    player.length > 64 ||
    events.length > 25
  ) {
    return res.status(400).json({ error: "bad payload" });
  }
  if (!(await getGame(game))) return res.status(404).json({ error: "unknown game" });

  const clean = events
    .filter((e) => e && typeof e.name === "string" && e.name.length <= 64)
    .map((e) => ({
      name: e.name.slice(0, 64),
      props:
        e.props && typeof e.props === "object" && JSON.stringify(e.props).length <= 1024
          ? e.props
          : null,
    }));

  const { browser, os } = parseUA(req.headers["user-agent"]);
  await recordBatch(
    game,
    session,
    player,
    {
      referrer: typeof meta.referrer === "string" ? meta.referrer.slice(0, 256) : null,
      screen: typeof meta.screen === "string" ? meta.screen.slice(0, 16) : null,
      lang: typeof meta.lang === "string" ? meta.lang.slice(0, 16) : null,
      browser,
      os,
    },
    clean
  );
  res.json({ ok: true });
}));

// ---------- admin API ----------
app.get("/api/games", requireAuth, ah(async (req, res) => res.json(await listGames())));

app.post("/api/games", requireAuth, ah(async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: "name required" });
  // Optional explicit id: lets you re-create a game with the id your shipped
  // clients already carry (e.g. after moving databases).
  const id = req.body?.id != null ? String(req.body.id) : undefined;
  if (id !== undefined && !/^[A-Za-z0-9_-]{4,32}$/.test(id)) {
    return res.status(400).json({ error: "bad id" });
  }
  if (id && (await getGame(id))) return res.status(409).json({ error: "id taken" });
  res.json(await createGame(name, id));
}));

app.delete("/api/games/:id", requireAuth, ah(async (req, res) => {
  await deleteGame(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/games/:id/stats", requireAuth, ah(async (req, res) => {
  if (!(await getGame(req.params.id))) return res.status(404).json({ error: "unknown game" });
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(await gameStats(req.params.id, days));
}));

app.get("/api/me", (req, res) => res.json({ authed: isAuthed(req) }));

// ---------- static ----------
app.get("/gg.js", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(path.join(__dirname, "public", "gg.js"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", isAuthed(req) ? "index.html" : "login.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => console.log(`game-analytics listening on :${PORT}`));
