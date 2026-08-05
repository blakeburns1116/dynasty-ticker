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
// grab up to N frames per read so a replay/menu/blurry moment doesn't lose the score
// (stops early once a clean full read is found, so it's not always all N)
const GRAB_ATTEMPTS = Number(process.env.SCORE_GRAB_ATTEMPTS || 6);
const GRAB_GAP_MS = Number(process.env.SCORE_GRAB_GAP_MS || 1000);
// don't archive to Final until a live stream has been missing this many checks
// (Twitch occasionally omits a live channel for one cycle)
const ARCHIVE_AFTER_MISSES = Number(process.env.SCORE_ARCHIVE_AFTER_MISSES || 2);

const normPair = (a, b) =>
  `${String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
let misses = {}; // login -> consecutive checks where a scored stream was not live

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

// OCR a single frame file.
async function readFrame(frame) {
  const { stdout } = await execFileP(
    "python3",
    [path.join(SCORE_DIR, "read_score.py"), frame, "--template", path.join(SCORE_DIR, "template.json")],
    { timeout: 30000 }
  );
  return JSON.parse(stdout.trim());
}

// Score a read's completeness so we can keep the best of several frames.
function readQuality(r) {
  if (!r || !r.ok) return -1;
  let q = r.confidence || 0;
  if (r.awayScore != null) q += 0.6;
  if (r.homeScore != null) q += 0.6;
  if (r.away) q += 0.3;
  if (r.home) q += 0.3;
  return q;
}
const goodEnough = r =>
  r && r.ok && r.awayScore != null && r.homeScore != null && (r.confidence || 0) >= MIN_CONF;

// Read one stream: grab up to GRAB_ATTEMPTS frames and keep the best read, so a
// replay/menu/blurry moment on the first grab doesn't lose the score.
// `frameOverride` lets tests skip grab.sh and read a fixed frame once.
async function readOne(login, frameOverride) {
  if (frameOverride) return readFrame(frameOverride);
  const frame = path.join(os.tmpdir(), `frame_${login}.jpg`);
  let best = { ok: false }, bestQ = -1;
  for (let i = 0; i < GRAB_ATTEMPTS; i++) {
    try {
      await execFileP("bash", [path.join(SCORE_DIR, "grab.sh"), login, frame], { timeout: 30000 });
      const r = await readFrame(frame);
      const q = readQuality(r);
      if (q > bestQ) { best = r; bestQ = q; }
      if (goodEnough(r)) break;                 // stop early on a clean full read
    } catch (e) { /* try the next frame */ }
    if (i < GRAB_ATTEMPTS - 1) await new Promise(res => setTimeout(res, GRAB_GAP_MS));
  }
  return best;
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
        // accept if both scores clearly read (strong validity), or confidence clears the bar
        const bothScores = r.ok && r.awayScore != null && r.homeScore != null;
        if (r.ok && (bothScores || (r.confidence ?? 0) >= MIN_CONF)) {
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

  // Undo premature/false finals: if a game is live again with a score, it isn't
  // final. Drop any final for the same stream OR the same team matchup.
  const liveMatchups = new Set();
  for (const login of liveByLogin.keys()) {
    const sc = scores[login];
    if (sc && (sc.awayScore != null || sc.homeScore != null)) {
      liveMatchups.add(normPair(sc.away, sc.home));
      liveMatchups.add(normPair(sc.home, sc.away)); // tolerate flipped home/away
    }
  }
  const before = finals.length;
  finals = finals.filter(f =>
    !liveByLogin.has(f.twitch) && !liveMatchups.has(normPair(f.away, f.home))
  );
  if (finals.length !== before) persistFinals();

  // A CONFIRMED dynasty stream missing for a few checks = game over -> Final.
  // One missed check is tolerated (transient Twitch drop) before archiving.
  for (const login of Object.keys(scores)) {
    if (liveByLogin.has(login)) { misses[login] = 0; continue; }
    misses[login] = (misses[login] || 0) + 1;
    if (misses[login] < ARCHIVE_AFTER_MISSES) continue;
    const sc = scores[login];
    if (sc.dynastyConfirmed && (sc.awayScore != null || sc.homeScore != null)) archiveFinal(login, sc);
    delete scores[login];
    delete misses[login];
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
