// scorewatch.js — read live scores off Twitch video for the dynasty ticker.
//
// For each live "on dynasty" stream it grabs a frame (score/grab.sh) and reads
// the EA score bug (score/read_score.py). Results are merged into /api/live.
// A manual override always wins over the camera read, because computer vision
// on a live scoreboard is good-not-perfect and you'll want to fix the odd miss.
//
// Everything is guarded by SCORE_ENABLED so the base ticker runs fine without
// the heavier video pipeline (ffmpeg + streamlink + python + tesseract).

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { scoreConfirmsTeam } from "./teams.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCORE_DIR = path.join(__dirname, "score");

const ENABLED = process.env.SCORE_ENABLED === "1";
const INTERVAL = Number(process.env.SCORE_SECONDS || 25) * 1000;
const CONCURRENCY = Number(process.env.SCORE_CONCURRENCY || 3);
const MIN_CONF = Number(process.env.SCORE_MIN_CONFIDENCE || 0.22);
const FRAME_TTL = Number(process.env.SCORE_STALE_SECONDS || 120) * 1000;

// login -> { away, home, awayScore, homeScore, quarter, clock, confidence, source, updatedAt, coach, team, startedAt }
let scores = {};
// completed games: { id, twitch, coach, team, away, home, awayScore, homeScore, endedAt, source }
let finals = [];
let storePath = path.join(__dirname, "scores.json");
let finalsPath = path.join(__dirname, "finals.json");

const FINAL_WINDOW_HRS = Number(process.env.SCORE_FINAL_HOURS || 24);

export function initStore(dataDir) {
  storePath = path.join(dataDir, "scores.json");
  finalsPath = path.join(dataDir, "finals.json");
  try { scores = JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { scores = {}; }
  try { finals = JSON.parse(fs.readFileSync(finalsPath, "utf8")); } catch { finals = []; }
}
function persist() {
  try { fs.writeFileSync(storePath, JSON.stringify(scores, null, 2)); } catch {}
}
function persistFinals() {
  // keep storage from growing forever: drop finals older than 7 days
  const cutoff = Date.now() - 7 * 864e5;
  finals = finals.filter(f => new Date(f.endedAt).getTime() > cutoff);
  try { fs.writeFileSync(finalsPath, JSON.stringify(finals, null, 2)); } catch {}
}

export function getScores() { return scores; }

// recent completed games, newest first
export function getFinals() {
  const cutoff = Date.now() - FINAL_WINDOW_HRS * 36e5;
  return finals
    .filter(f => new Date(f.endedAt).getTime() > cutoff)
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
}

// move a stream's last score into the finals list (deduped by twitch+startedAt)
function archiveFinal(login, sc) {
  const id = `${login}_${sc.startedAt || ""}`;
  const rec = {
    id, twitch: login, coach: sc.coach || login, team: sc.team || "",
    away: sc.away || null, home: sc.home || null,
    awayScore: sc.awayScore ?? null, homeScore: sc.homeScore ?? null,
    endedAt: new Date().toISOString(), source: sc.source || "cv",
  };
  const i = finals.findIndex(f => f.id === id);
  if (i >= 0) finals[i] = { ...finals[i], ...rec, endedAt: finals[i].endedAt };
  else finals.push(rec);
  persistFinals();
}

export function editFinal(id, data) {
  const f = finals.find(x => x.id === id);
  if (!f) return null;
  if (data.away !== undefined) f.away = data.away || null;
  if (data.home !== undefined) f.home = data.home || null;
  if (data.awayScore !== undefined) f.awayScore = num(data.awayScore);
  if (data.homeScore !== undefined) f.homeScore = num(data.homeScore);
  f.source = "manual";
  persistFinals();
  return f;
}

export function removeFinal(id) {
  finals = finals.filter(f => f.id !== id);
  persistFinals();
}

export function setManual(login, data) {
  login = login.toLowerCase();
  const prev = scores[login] || {};
  scores[login] = {
    away: data.away ?? null,
    home: data.home ?? null,
    awayScore: num(data.awayScore),
    homeScore: num(data.homeScore),
    quarter: data.quarter ?? null,
    clock: data.clock ?? null,
    confidence: 1,
    source: "manual",
    updatedAt: new Date().toISOString(),
    coach: data.coach ?? prev.coach ?? null,
    team: prev.team ?? null,
    startedAt: prev.startedAt ?? null,
    dynastyConfirmed: true, // a human entering a score vouches it's this dynasty
  };
  persist();
  return scores[login];
}

export function clearScore(login) {
  login = login.toLowerCase();
  delete scores[login];
  persist();
}

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Read one stream: grab a frame, OCR it. `frameOverride` lets tests skip grab.sh.
async function readOne(login, frameOverride) {
  const frame = frameOverride || path.join(os.tmpdir(), `frame_${login}.jpg`);
  if (!frameOverride) {
    await execFileP("bash", [path.join(SCORE_DIR, "grab.sh"), login, frame], { timeout: 30000 });
  }
  const { stdout } = await execFileP(
    "python3",
    [path.join(SCORE_DIR, "read_score.py"), frame, "--template", path.join(SCORE_DIR, "template.json")],
    { timeout: 30000 }
  );
  return JSON.parse(stdout.trim());
}

// Update scores for all currently-live on-dynasty streams.
export async function updateScores(liveStreams, { frameFor } = {}) {
  const liveByLogin = new Map(
    liveStreams.filter(s => s.onDynasty).map(s => [s.twitch.toLowerCase(), s])
  );
  // never overwrite a manual correction with a camera read
  const queue = [...liveByLogin.keys()].filter(l => scores[l]?.source !== "manual");

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async login => {
      try {
        const r = await readOne(login, frameFor ? frameFor(login) : null);
        if (r.ok && (r.confidence ?? 0) >= MIN_CONF) {
          const st = liveByLogin.get(login) || {};
          // sticky: once a read shows their team, stay confirmed for the session
          const confirmed = scores[login]?.dynastyConfirmed || scoreConfirmsTeam(r, st.team);
          scores[login] = {
            ...r, source: "cv", updatedAt: new Date().toISOString(),
            coach: st.coach || null, team: st.team || null, startedAt: st.startedAt || null,
            dynastyConfirmed: !!confirmed,
          };
        }
        // if not ok (menu/replay), we keep the last reading; staleness handled on read
      } catch (e) {
        // channel dropped, grab failed, etc. — leave prior reading in place
      }
    }));
  }

  // a CONFIRMED dynasty stream that is no longer live = game over -> Final.
  // unconfirmed reads (other dynasties) are discarded, never archived.
  for (const login of Object.keys(scores)) {
    if (!liveByLogin.has(login)) {
      const sc = scores[login];
      if (sc.dynastyConfirmed && (sc.awayScore != null || sc.homeScore != null)) archiveFinal(login, sc);
      delete scores[login];
    }
  }
  persist();
}

// Attach score info onto the live stream objects for /api/live.
export function decorate(streams) {
  const now = Date.now();
  return streams.map(s => {
    const sc = scores[s.twitch.toLowerCase()];
    if (!sc) return s;
    const stale = sc.source === "cv" && now - new Date(sc.updatedAt).getTime() > FRAME_TTL;
    return { ...s, score: stale ? { ...sc, stale: true } : sc };
  });
}

export function startLoop(getLiveStreams) {
  if (!ENABLED) {
    console.log("Score reading disabled (set SCORE_ENABLED=1 to turn on the video pipeline).");
    return;
  }
  console.log(`Score reading ON — every ${INTERVAL / 1000}s, ${CONCURRENCY} streams at a time.`);
  const tick = async () => {
    try { await updateScores(getLiveStreams()); }
    catch (e) { console.error("score loop error:", e.message); }
  };
  tick();
  setInterval(tick, INTERVAL);
}
