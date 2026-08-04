// Dynasty Ticker — live Twitch board + weekly activity tracker for an NCAA 27 dynasty.
// Pure Node + Express. No native deps, no database engine — sessions are logged to a JSON file.
//
// Run:  npm install  then  npm start
// Try it with fake data first (no Twitch keys needed):  npm run mock

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as scorewatch from "./scorewatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- tiny .env loader (avoids adding a dependency) ----------
function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const MOCK = process.env.MOCK === "1";
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const GAME_NAME = (process.env.DYNASTY_GAME_NAME || "").trim();
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 45);
const PORT = Number(process.env.PORT || 3000);
// DATA_DIR lets the activity log live on a persistent cloud volume so weekly
// history survives restarts/redeploys. Falls back to the app folder locally.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, "sessions.json");

// ---------- config files ----------
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")); }
  catch { return fallback; }
};
const getMembers = () => readJson("members.json", { members: [] }).members;
const getSchedule = () => readJson("schedule.json", { week: 0, matchups: [] });
const getStandings = () => readJson("standings.json", { teams: {} });

// ---------- session log (append-only JSON) ----------
// Each record: { twitch, coach, team, game, title, startedAt, lastSeen, week }
function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); } catch { return []; }
}
function writeLog(rows) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(rows, null, 2));
}

// Live snapshot, refreshed by the poller.
let liveSnapshot = { updatedAt: null, streams: [] };

// ---------- Twitch auth (client-credentials app token) ----------
let appToken = null;
let tokenExpiresAt = 0;
async function getToken() {
  if (appToken && Date.now() < tokenExpiresAt - 60000) return appToken;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}` +
    `&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Twitch token error ${res.status}: ${await res.text()}`);
  const j = await res.json();
  appToken = j.access_token;
  tokenExpiresAt = Date.now() + j.expires_in * 1000;
  return appToken;
}

// ---------- fetch who is live ----------
async function fetchLiveStreams(logins) {
  if (MOCK) return mockStreams(logins);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn("No Twitch keys set — falling back to mock data. Copy .env.example to .env.");
    return mockStreams(logins);
  }
  const token = await getToken();
  const out = [];
  // Twitch allows up to 100 user_login params per call; chunk to be safe.
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    const qs = chunk.map(l => `user_login=${encodeURIComponent(l)}`).join("&");
    const res = await fetch(`https://api.twitch.tv/helix/streams?first=100&${qs}`, {
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Twitch streams error ${res.status}: ${await res.text()}`);
    const j = await res.json();
    out.push(...j.data);
  }
  return out;
}

// ---------- poll loop: refresh live board + log sessions ----------
async function poll() {
  try {
    const members = getMembers();
    const byLogin = new Map(members.map(m => [m.twitch.toLowerCase(), m]));
    const raw = await fetchLiveStreams([...byLogin.keys()]);
    const now = new Date().toISOString();
    const week = getSchedule().week;

    const streams = raw.map(s => {
      const m = byLogin.get((s.user_login || "").toLowerCase()) || {};
      const onDynasty = !GAME_NAME || (s.game_name || "").toLowerCase() === GAME_NAME.toLowerCase();
      return {
        twitch: s.user_login,
        displayName: s.user_name,
        coach: m.coach || s.user_name,
        team: m.team || "",
        game: s.game_name || "",
        title: s.title || "",
        viewers: s.viewer_count || 0,
        startedAt: s.started_at,
        onDynasty,
        thumbnail: (s.thumbnail_url || "").replace("{width}", "320").replace("{height}", "180"),
        url: `https://twitch.tv/${s.user_login}`
      };
    });

    liveSnapshot = { updatedAt: now, streams };
    logSessions(streams, now, week);
    console.log(`[${now}] ${streams.length} live (${streams.filter(s => s.onDynasty).length} on dynasty)`);
  } catch (e) {
    console.error("Poll failed:", e.message);
  }
}

// Merge current live streams into the append-only session log.
// A session = a continuous stream. We match on twitch+startedAt so a single
// stream is one row whose lastSeen keeps advancing while they're live.
function logSessions(streams, now, week) {
  const rows = readLog();
  for (const s of streams) {
    if (GAME_NAME && !s.onDynasty) continue; // only log dynasty play
    const key = r => r.twitch === s.twitch && r.startedAt === s.startedAt;
    let row = rows.find(key);
    if (row) {
      row.lastSeen = now;
      row.title = s.title;
    } else {
      rows.push({
        twitch: s.twitch, coach: s.coach, team: s.team, game: s.game,
        title: s.title, startedAt: s.startedAt, lastSeen: now, week
      });
    }
  }
  writeLog(rows);
}

// ---------- weekly rollup ----------
function weeklyRollup() {
  const rows = readLog();
  const members = getMembers();
  const schedule = getSchedule();
  const week = schedule.week;

  // Per-coach totals for the current week.
  const stat = new Map();
  const ensure = c => stat.get(c) || stat.set(c, { coach: c, sessions: 0, minutes: 0, lastSeen: null }).get(c);
  for (const r of rows.filter(r => r.week === week)) {
    const s = ensure(r.coach);
    s.sessions += 1;
    s.minutes += Math.max(0, Math.round((new Date(r.lastSeen) - new Date(r.startedAt)) / 60000));
    if (!s.lastSeen || r.lastSeen > s.lastSeen) s.lastSeen = r.lastSeen;
  }

  // Everyone in the dynasty, even those who haven't played, so "who's behind" is visible.
  const activity = members.map(m => {
    const s = stat.get(m.coach) || { sessions: 0, minutes: 0, lastSeen: null };
    return { coach: m.coach, team: m.team, twitch: m.twitch, ...s, played: s.sessions > 0 };
  }).sort((a, b) => b.minutes - a.minutes);

  // Matchup progress: a game is "likely played" when both sides have logged play this week.
  const played = new Set(activity.filter(a => a.played).map(a => a.coach));
  const matchups = (schedule.matchups || []).map(mu => {
    const homePlayed = played.has(mu.home);
    const awayPlayed = mu.away === "CPU" ? homePlayed : played.has(mu.away);
    return { ...mu, homePlayed, awayPlayed, likelyPlayed: homePlayed && awayPlayed };
  });

  return { week, seasonYear: schedule.seasonYear, activity, matchups };
}

// ---------- mock data for a keyless test drive ----------
function mockStreams(logins) {
  const g = GAME_NAME || "EA Sports College Football 27";
  const pick = logins.slice(0, Math.max(1, Math.floor(logins.length / 2)));
  const startedAgo = mins => new Date(Date.now() - mins * 60000).toISOString();
  return pick.map((login, i) => ({
    user_login: login,
    user_name: login,
    game_name: i === pick.length - 1 ? "Just Chatting" : g, // one off-game to show filtering
    title: i === pick.length - 1 ? "hanging out" : `Dynasty Week ${getSchedule().week} — rivalry game`,
    viewer_count: 5 + i * 3,
    started_at: startedAgo(20 + i * 15),
    thumbnail_url: ""
  }));
}

// ---------- web server ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Live board. Only streams CONFIRMED to be this dynasty are shown — i.e. a
// scoreboard read (or manual entry) matched the coach's assigned team. This keeps
// out other dynasties the same coaches stream in the same game.
app.get("/api/live", (_req, res) => {
  const decorated = scorewatch.decorate(liveSnapshot.streams);
  const confirmed = decorated
    .filter(s => s.score && s.score.dynastyConfirmed)
    .map(s => ({ ...s, onDynasty: true }));
  res.json({ updatedAt: liveSnapshot.updatedAt, streams: confirmed });
});
app.get("/api/weekly", (_req, res) => res.json(weeklyRollup()));
app.get("/api/schedule", (_req, res) => res.json(getSchedule()));
app.get("/api/members", (_req, res) => res.json({ members: getMembers() }));
app.get("/api/standings", (_req, res) => res.json(getStandings()));

// Completed games (auto-archived when a stream ends).
app.get("/api/finals", (_req, res) => res.json({ finals: scorewatch.getFinals() }));
app.post("/api/final/:id", (req, res) => res.json(scorewatch.editFinal(req.params.id, req.body || {}) || {}));
app.delete("/api/final/:id", (req, res) => { scorewatch.removeFinal(req.params.id); res.json({ ok: true }); });

// Manual live score override (always beats the camera read until cleared).
app.post("/api/score/:twitch", (req, res) => {
  res.json(scorewatch.setManual(req.params.twitch, req.body || {}));
});
app.delete("/api/score/:twitch", (req, res) => {
  scorewatch.clearScore(req.params.twitch);
  res.json({ ok: true });
});

scorewatch.initStore(DATA_DIR);

app.listen(PORT, () => {
  console.log(`Dynasty Ticker running at http://localhost:${PORT}  ${MOCK ? "(MOCK MODE)" : ""}`);
  poll();
  setInterval(poll, POLL_SECONDS * 1000);
  scorewatch.startLoop(() => liveSnapshot.streams);
});
