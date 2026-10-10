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
import { scoreConfirmsTeam, confirmDynasty, resolveTeam, resolveAny, schoolName, matchesTeam } from "./teams.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCORE_DIR = path.join(__dirname, "score");

const ENABLED = process.env.SCORE_ENABLED === "1";
const INTERVAL = Number(process.env.SCORE_SECONDS || 25) * 1000;
const CONCURRENCY = Number(process.env.SCORE_CONCURRENCY || 1);
const MIN_CONF = Number(process.env.SCORE_MIN_CONFIDENCE || 0.22);
const FRAME_TTL = Number(process.env.SCORE_STALE_SECONDS || 120) * 1000;
// grab up to N frames per read so a replay/menu/blurry moment doesn't lose the score.
// Frames are pulled at ~1/sec, so N is ALSO the capture-window length in seconds.
// A longer window catches more moments where the score bug is cleanly visible
// (between snaps, replays, and HUD animations) and makes the majority vote much
// harder for a stray misread to swing.
const GRAB_ATTEMPTS = Number(process.env.SCORE_GRAB_ATTEMPTS || 16);
// A read of a single game is only "stable" (eligible to be shown or to alert)
// after this many complete reads AND this much elapsed time — so a game never
// shows a score or fires an alert off the first noisy read.
const STABLE_MIN_READS = Number(process.env.SCORE_STABLE_READS || 3);
const STABLE_MIN_MS = Number(process.env.SCORE_STABLE_MS || 50000);
// a quarter must repeat this many committed cycles before it counts as confirmed
const QSTABLE_MIN = Number(process.env.SCORE_QSTABLE_MIN || 2);
// When a score appears to RESET/drop mid-game, re-pull this many frames to
// confidently re-sync to the true current score (loosens the "never drop" rule).
const RESET_CONFIRM_FRAMES = Number(process.env.SCORE_RESET_FRAMES || 20);
const RESET_CONFIRM_CONF = Number(process.env.SCORE_RESET_CONF || 0.45);
// On a missed/incomplete read, retry immediately this many times before giving
// up for the cycle (instead of waiting a full interval).
const MISS_RETRIES = Number(process.env.SCORE_MISS_RETRIES || 3);
const GRAB_GAP_MS = Number(process.env.SCORE_GRAB_GAP_MS || 1000);
// don't archive to Final until a live stream has been missing this many checks
// (Twitch occasionally omits a live channel for one cycle)
const ARCHIVE_AFTER_MISSES = Number(process.env.SCORE_ARCHIVE_AFTER_MISSES || 2);
// Keep a rolling log of confident, complete readings for the WHOLE game so the
// FINAL can be computed from the game's true peak (confirmed by several frames)
// instead of the single last frame — which is often a replay/menu/postgame garble.
const HISTORY_MIN_CONF = Number(process.env.SCORE_HISTORY_MIN_CONF || 0.4);
const HISTORY_MAX = Number(process.env.SCORE_HISTORY_MAX || 80);
// a scoreline must be seen in at least this many confident frames to be "confirmed"
const FINAL_CONFIRM_VOTES = Number(process.env.SCORE_FINAL_CONFIRM_VOTES || 2);

// A suspicious score jump (not explainable by real football scoring in the time
// elapsed) must repeat unchanged this many cycles before it is believed.
const JUMP_CONFIRM = Number(process.env.SCORE_JUMP_CONFIRM || 2);
// The bug must read FINAL this many cycles in a row (after the 3rd quarter) to end a game.
const FINAL_CYCLES = Number(process.env.SCORE_FINAL_CYCLES || 2);
// New teams on the bug (plus a score/quarter reset) must repeat this many cycles to start a new game.
const NEW_GAME_CONFIRM = Number(process.env.SCORE_NEW_GAME_CONFIRM || 2);
// Two streams that archive the same matchup within this window are one game.
const GAME_MERGE_MS = Number(process.env.SCORE_GAME_MERGE_HOURS || 4) * 36e5;
// A stream-drop final is undone if the same matchup is live again within this window.
const PREMATURE_FINAL_MS = Number(process.env.SCORE_PREMATURE_MINUTES || 30) * 6e4;

const QRANK = { "1ST": 1, "2ND": 2, "HALF": 2.5, "3RD": 3, "4TH": 4, "OT": 5, "FINAL": 6 };

// ---- Discord webhook (optional) ----
// Set DISCORD_WEBHOOK_URL in the environment to post a message to your league's
// main chat when a dynasty game gets close entering the 4th quarter. Set
// DISCORD_MENTION to "@here" (or a role mention) to actually ping the channel.
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || "").trim();
const DISCORD_MENTION = (process.env.DISCORD_MENTION || "").trim();
const CLOSE_MARGIN = Number(process.env.CLOSE_GAME_MARGIN || 8); // one-score = close
// "upset/comeback": trailing team was down at least this much at half...
const COMEBACK_MIN = Number(process.env.COMEBACK_MIN_MARGIN || 9); // ...more than one score
// "lead change": the half-underdog was down at least this much at half and then
// takes the lead during the 4th/OT (the comeback completed live).
const LEAD_CHANGE_MIN = Number(process.env.LEAD_CHANGE_MIN_MARGIN || 1);
// per-matchup memory so the ping fires once per game, league-wide (not per viewer)
let alertState = {};

const normPair = (a, b) =>
  `${String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
let misses = {}; // login -> consecutive checks where a scored stream was not live
let lastRead = {}; // login -> last RAW ocr {away,home}, to confirm a real score correction
let qPend = {}; // login -> { q, n } pending quarter awaiting multi-cycle confirmation
let gamePend = {}; // login -> { k, n } pending "new game started" evidence
let jumpPend = {}; // login -> { a, h, n } pending implausible score jump
let lastMissSnap = null; // Twitch snapshot we last counted misses for
let namePend = {}; // login+side -> { v, n } pending team-name change awaiting confirmation
// a locked team name only flips after a different school is read this many cycles
const NAME_CONFIRM = Number(process.env.SCORE_NAME_CONFIRM || 2);
// how many consecutive cycles a NEW quarter must be read before we commit to it.
// One forward step (e.g. 3RD->4TH) is normal, so 2; a leap, a regression, or OT is
// suspicious (usually a misread of the tiny quarter box), so demand 3.
const QCONFIRM_STEP = Number(process.env.SCORE_QCONFIRM_STEP || 2);
const QCONFIRM_JUMP = Number(process.env.SCORE_QCONFIRM_JUMP || 3);

// ---- football scoring legality ------------------------------------------------
// A team's score can only move by 1 (PAT), 2 (safety / 2-pt), 3 (FG), 6 (TD) or
// 7 / 8 (TD plus conversion) per scoring event. MIN_EVENTS[d] is the fewest events
// that add up to d points (Infinity if impossible within 5 events).
const SCORING = [1, 2, 3, 6, 7, 8];
const MIN_EVENTS = (() => {
  const t = new Array(81).fill(Infinity); t[0] = 0;
  for (let d = 1; d <= 80; d++) for (const p of SCORING) if (d >= p && t[d - p] + 1 < t[d]) t[d] = t[d - p] + 1;
  return t;
})();
export function minEvents(d) { return d < 0 || d > 80 ? Infinity : MIN_EVENTS[d]; }
// Could the score have gone from (prev) to (next) in elapsedSec? One scoring event
// is allowed per ~minute of gap (always at least one), since menus/replays can hide plays.
export function plausibleJump(dAway, dHome, elapsedSec) {
  const budget = 1 + Math.floor(Math.max(0, elapsedSec) / 60);
  return minEvents(dAway) + minEvents(dHome) <= budget;
}

// login -> { away, home, awayScore, homeScore, quarter, clock, confidence, source, updatedAt, coach, team, startedAt }
let scores = {};
// completed games: { id, twitch, coach, team, away, home, awayScore, homeScore, endedAt, source }
let finals = [];
let storePath = path.join(__dirname, "scores.json");
let finalsPath = path.join(__dirname, "finals.json");

const FINAL_WINDOW_HRS = Number(process.env.SCORE_FINAL_HOURS || 48);

export function initStore(dataDir) {
  storePath = path.join(dataDir, "scores.json");
  finalsPath = path.join(dataDir, "finals.json");
  try { scores = JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { scores = {}; }
  try { finals = JSON.parse(fs.readFileSync(finalsPath, "utf8")); } catch { finals = []; }
  // Scores survive a restart, but the volatile game STATE must not: a stale/stuck
  // quarter or "confirmed" flag from disk could fire a false alert before live
  // reads catch up. Reset them so the quarter and confirmation rebuild on air.
  for (const k of Object.keys(scores)) {
    if (!scores[k]) continue;
    scores[k].quarter = null;
    scores[k].qStableN = 0;
    scores[k].qConfirmed = false;
    scores[k].confirmed = false;
  }
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

// Derive the true final from the whole game's confident readings instead of the
// single last frame. Each history entry is a cycle whose fresh read AGREED with the
// committed (legality-checked) score, so the final is the highest-total scoreline
// that was confirmed in several cycles. The scoreline is chosen JOINTLY (both
// sides together), so two different moments can never be stitched into a score the
// game never had (e.g. 21-7 and 14-21 -> "21-21").
export function confirmedFinal(sc) {
  const hist = Array.isArray(sc.history) ? sc.history : [];
  const settled = hist.filter(e => e && e.a != null && e.h != null);
  const pairs = new Map();
  for (const e of settled) { const k = e.a + "-" + e.h; pairs.set(k, (pairs.get(k) || 0) + 1); }
  let a = null, h = null, best = -1;
  for (const [k, c] of pairs) {
    if (c < FINAL_CONFIRM_VOTES) continue;
    const [pa, ph] = k.split("-").map(Number);
    if (pa + ph > best) { best = pa + ph; a = pa; h = ph; }
  }
  let thin = false;
  const la = sc.awayScore ?? null, lh = sc.homeScore ?? null;
  if (a == null) { a = la; h = lh; thin = true; }
  else if (la != null && lh != null && la >= a && lh >= h && (la !== a || lh !== h) &&
           plausibleJump(la - a, lh - h, 120)) { a = la; h = lh; } // a last score not yet confirmed twice
  // Team NAMES by whole-game majority of CANONICAL school names, so a garbled
  // end-of-game read can never win against hundreds of correct ones.
  const modeName = key => {
    const counts = new Map();
    for (const e of hist) { const v = e && e[key]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    let top = null, bc = 0;
    for (const [v, c] of counts) if (c > bc) { bc = c; top = v; }
    return top;
  };
  const maxQ = hist.reduce((m, e) => Math.max(m, QRANK[e && e.q] || 0), 0);
  return { awayScore: a, homeScore: h, away: modeName("aw"), home: modeName("hm"), votes: settled.length, thin, maxQ };
}

const pairKey = (a, b) =>
  [a, b].map(x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "")).sort().join("|");
// id of a stream's current game: the first game keeps the legacy id shape
const finalIdFor = (login, sc) => `${login}_${(sc && sc.startedAt) || ""}` + ((sc && sc.gameNo) > 1 ? `_g${sc.gameNo}` : "");

// move a stream's game into the finals list. Uses the whole-game confirmed final,
// canonical school names, and flags anything a human should double check.
function archiveFinal(login, sc, source = "cv") {
  const id = finalIdFor(login, sc);
  const cf = confirmedFinal(sc);
  let away = cf.away || schoolName(sc.away) || sc.away || null;
  let home = cf.home || schoolName(sc.home) || sc.home || null;
  // the coach's own team is known for certain: pin that side instead of trusting OCR
  if (sc.team) {
    if (away && matchesTeam(away, sc.team)) away = sc.team;
    else if (home && matchesTeam(home, sc.team)) home = sc.team;
  }
  const flags = [];
  if (cf.awayScore == null || cf.homeScore == null) flags.push("missing-score");
  else if (cf.awayScore === cf.homeScore) flags.push("tie");
  if (!away || !home || !schoolName(away) || !schoolName(home)) flags.push("unverified-team");
  if (cf.thin) flags.push("thin-evidence");
  if (source !== "cv-final" && cf.maxQ < 4) flags.push("partial-game");
  console.log(`archive ${login} g${sc.gameNo || 1}: final ${away} ${cf.awayScore}-${cf.homeScore} ${home} ` +
    `(${cf.votes} confirming reads, ${source}${flags.length ? ", REVIEW: " + flags.join(",") : ""}; ` +
    `last live ${sc.away}/${sc.home} ${sc.awayScore}-${sc.homeScore})`);
  const rec = {
    id, twitch: login, coach: sc.coach || login, team: sc.team || "", dynasty: sc.dynasty || null,
    away, home, awayScore: cf.awayScore ?? null, homeScore: cf.homeScore ?? null,
    endedAt: new Date().toISOString(), source, gameNo: sc.gameNo || 1,
    votes: cf.votes, flags, needsReview: flags.length > 0,
  };
  // The same game streamed by both coaches is ONE final; the second stream cross-checks the first.
  const key = pairKey(away, home);
  const dup = key !== "|" && finals.find(f => f.id !== id && f.twitch !== login &&
    pairKey(f.away, f.home) === key && Date.now() - new Date(f.endedAt).getTime() < GAME_MERGE_MS);
  if (dup) {
    const flip = dup.away !== rec.away;
    const same = flip
      ? dup.awayScore === rec.homeScore && dup.homeScore === rec.awayScore
      : dup.awayScore === rec.awayScore && dup.homeScore === rec.homeScore;
    dup.streams = [...new Set([...(dup.streams || [dup.twitch]), login])];
    if (same) {
      dup.crossChecked = true;
      dup.flags = (dup.flags || []).filter(f => f !== "thin-evidence" && f !== "partial-game");
    } else {
      dup.flags = [...new Set([...(dup.flags || []), "stream-mismatch"])];
      dup.alt = { twitch: login, awayScore: flip ? rec.homeScore : rec.awayScore, homeScore: flip ? rec.awayScore : rec.homeScore };
    }
    dup.needsReview = dup.flags.length > 0;
    persistFinals();
    return dup;
  }
  const i = finals.findIndex(f => f.id === id);
  if (i >= 0) finals[i] = { ...finals[i], ...rec, endedAt: finals[i].endedAt };
  else finals.push(rec);
  persistFinals();
  return rec;
}

// Bank a game that is ending (new game started, stream restarted) if it was a real,
// locked-on game; never archive a game that already got its FINAL.
function bankGame(login, sc, source = "cv") {
  if (!sc || sc.gameOver) return;
  if (sc.dynastyConfirmed && sc.stable && (sc.awayScore != null || sc.homeScore != null)) archiveFinal(login, sc, source);
}
function resetPend(login) {
  qPend[login] = null; gamePend[login] = null; jumpPend[login] = null;
  delete namePend[login + "|a"]; delete namePend[login + "|h"];
}

// Manually add (or upsert) a completed game to the Final board. Used to restore
// finals that were lost, or to log a game the reader never saw.
export function addFinal(data) {
  const away = canonName(data.away), home = canonName(data.home);
  const key = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = data.id || `add_${key(away)}_${key(home)}`;
  const rec = {
    id, twitch: data.twitch || id,
    coach: data.coach || "", team: data.team || "", dynasty: data.dynasty || null,
    away, home, awayScore: num(data.awayScore), homeScore: num(data.homeScore),
    endedAt: new Date().toISOString(), source: "manual", flags: [], needsReview: false,
  };
  const i = finals.findIndex(f => f.id === id);
  if (i >= 0) finals[i] = rec; else finals.push(rec);
  persistFinals();
  return rec;
}

// Commissioner typed an abbreviation ("GASO", "MSU")? Store the real school name when we recognize it.
const canonName = s => (s ? (schoolName(s) || String(s).trim()) : null);

export function editFinal(id, data) {
  const f = finals.find(x => x.id === id);
  if (!f) return null;
  if (data.away !== undefined) f.away = canonName(data.away);
  if (data.home !== undefined) f.home = canonName(data.home);
  if (data.awayScore !== undefined) f.awayScore = num(data.awayScore);
  if (data.homeScore !== undefined) f.homeScore = num(data.homeScore);
  if (data.dynasty !== undefined) f.dynasty = data.dynasty || null;
  f.source = "manual"; f.flags = []; f.needsReview = false; // a human just verified it
  persistFinals();
  return f;
}

export function removeFinal(id) {
  finals = finals.filter(f => f.id !== id);
  persistFinals();
}

// Commissioner action: wipe all finals (e.g. rolling to a new week).
export function clearAllFinals() {
  finals = [];
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
    dynasty: data.dynasty ?? prev.dynasty ?? null,
    startedAt: prev.startedAt ?? null,
    dynastyConfirmed: true, // a human entering a score vouches it's this dynasty
  };
  persist();
  return scores[login];
}

export function clearScore(login) {
  login = login.toLowerCase();
  delete scores[login];
  delete qPend[login];
  delete namePend[login + "|a"]; delete namePend[login + "|h"];
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

// OCR several frame files in ONE python process (loads OpenCV/Tesseract once).
async function readFrames(files) {
  const { stdout } = await execFileP(
    "python3",
    [path.join(SCORE_DIR, "read_score.py"), ...files, "--template", path.join(SCORE_DIR, "template.json")],
    { timeout: Math.max(60000, files.length * 5000) }
  );
  const j = JSON.parse(stdout.trim());
  return j.frames ? j.frames : [j];
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

// Most common non-empty value across frames, with its vote count.
function modeOf(vals) {
  const m = new Map(); let seen = 0;
  for (const v of vals) { if (v == null || v === "") continue; seen++; m.set(v, (m.get(v) || 0) + 1); }
  let best = null, bc = 0;
  for (const [v, c] of m) if (c > bc) { bc = c; best = v; }
  return { val: best, count: bc, seen };
}
// Team string: most common, tie-broken toward the longer (less-truncated) read.
function bestTeamName(vals) {
  const nn = vals.filter(v => v);
  if (!nn.length) return null;
  const m = new Map();
  for (const v of nn) m.set(v, (m.get(v) || 0) + 1);
  const entries = [...m.entries()];
  // Prefer reads that resolve to a REAL school (roster or FBS) over garbles like
  // "FU"/"MICHIG"; then most common; then the longer (less-truncated) spelling.
  const resolvable = entries.filter(([v]) => resolveAny(v));
  const pool = resolvable.length ? resolvable : entries;
  pool.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return pool[0][0];
}
// Fuse several frame reads into one consensus reading. Each field is decided by a
// vote across frames, so a single garbled frame can't move a score. Scores must
// appear in >=2 frames (when we have >=3) to be trusted at all.
function consensus(reads) {
  const ok = reads.filter(r => r && r.ok);
  if (!ok.length) return { ok: false };
  const aS = modeOf(ok.map(r => r.awayScore));
  const hS = modeOf(ok.map(r => r.homeScore));
  const q = modeOf(ok.map(r => r.quarter));
  const clk = modeOf(ok.map(r => r.clock));
  const dd = modeOf(ok.map(r => r.downDistance));
  const poss = modeOf(ok.map(r => r.possession));
  // A score is only trusted when it wins a MAJORITY of the frames we read this
  // cycle (and at least 2). With 8 frames a lone garble frame can't set a score.
  const need = Math.max(2, Math.ceil(ok.length / 2));
  const trust = m => (ok.length >= 3 ? (m.count >= need ? m.val : null) : m.val);
  const agree = ((aS.count || 0) + (hS.count || 0)) / (2 * Math.max(1, ok.length));
  const rawConf = Math.max(0, ...ok.map(r => r.confidence || 0));
  return {
    ok: true,
    away: bestTeamName(ok.map(r => r.away)),
    home: bestTeamName(ok.map(r => r.home)),
    awayScore: trust(aS) ?? null,
    homeScore: trust(hS) ?? null,
    quarter: q.val ?? null,
    clock: clk.val ?? null,
    downDistance: dd.val ?? null,
    possession: poss.val ?? null,
    confidence: Math.max(agree, rawConf),
    frames: ok.length,
  };
}

// Read one stream: grab `frames` frames spread over a few seconds and return the
// consensus across them, so a replay/menu/blurry/garbled frame is outvoted.
// `frameOverride` lets tests skip grab.sh and read a fixed frame once. A larger
// `frames` (e.g. 20) is used to re-sync confidently after an apparent score reset.
// Tests swap in a scripted reader so the whole game-tracking pipeline can run without video.
let readerImpl = null;
export function __setReader(fn) { readerImpl = fn; }
async function readOne(login, frameOverride, frames = GRAB_ATTEMPTS) {
  if (readerImpl) return readerImpl(login, frames);
  if (frameOverride) return readFrame(frameOverride);
  const prefix = path.join(os.tmpdir(), `frame_${login}`);
  let reads = [];
  try {
    // one stream pull -> N frames (spread ~1s apart) -> one OCR process
    await execFileP("bash", [path.join(SCORE_DIR, "grab.sh"), login, prefix, String(frames)],
      { timeout: Math.max(120000, frames * 6000) });
    const files = [];
    for (let i = 1; i <= frames; i++) { const fp = `${prefix}_${i}.jpg`; if (fs.existsSync(fp)) files.push(fp); }
    if (files.length) reads = (await readFrames(files)).filter(r => r && r.ok);
  } catch (e) { /* stream not grabbable this cycle — keep prior reading */ }
  return consensus(reads);
}

// ---- close-game Discord ping (server-side, fires once per game) ----
const hasBothScores = sc => sc && sc.awayScore != null && sc.homeScore != null;
const normOne = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// stable matchup key: canonical team pair (order-independent), no per-stream startedAt
function matchupKey(sc) {
  const a = resolveTeam(sc.away) || normOne(sc.away);
  const b = resolveTeam(sc.home) || normOne(sc.home);
  return [a, b].sort().join("|");
}

const SITE_URL = process.env.SITE_URL || "https://dynasty-ticker-production.up.railway.app";

// Low-level webhook send.
async function sendDiscord(content, embed) {
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed] }),
    });
    if (!res.ok) console.error("Discord webhook HTTP", res.status);
  } catch (e) { console.error("Discord webhook failed:", e.message); }
}

// Shared embed: score line + a button-style Gameday Live link + coach streams.
// (A plain webhook can't render real Discord buttons — that needs a bot — so the
// bold hyperlink is the one-tap equivalent.)
function gameEmbed(sc, streams, subtitle, color) {
  const A = resolveTeam(sc.away) || sc.away || "Away";
  const B = resolveTeam(sc.home) || sc.home || "Home";
  const watch = streams.map(s => `[${s.coach}](${s.url})`).join("  ·  ");
  const fields = [{ name: "​", value: `**▶  [WATCH ON GAMEDAY LIVE](${SITE_URL})**` }];
  if (watch) fields.push({ name: "Coaches streaming", value: watch });
  return {
    title: "🏈 Aftermath College Gameday Live", url: SITE_URL,
    description: `**${A} ${sc.awayScore}**  —  **${B} ${sc.homeScore}**\n${subtitle}`,
    color, fields, footer: { text: "College Gameday Live · tap the title or the button above" },
  };
}
const mention = () => (DISCORD_MENTION ? DISCORD_MENTION + " " : "");

async function postCloseGame(sc, streams, margin) {
  const clk = sc.clock ? ` · ${sc.clock} on the clock` : "";
  await sendDiscord(mention() + "🔥 **CLOSE GAME — entering the 4th quarter!**",
    gameEmbed(sc, streams, `${margin === 0 ? "Tied" : margin + " apart"} heading into the 4th${clk}`, 0xe11d48));
}

async function postComeback(sc, streams, trailTeam, htMargin, nowText) {
  const clk = sc.clock ? ` · ${sc.clock} to play` : "";
  await sendDiscord(mention() + "🔄 **UPSET BREWING — big comeback into the 4th!**",
    gameEmbed(sc, streams, `**${trailTeam}** were down ${htMargin} at the half — ${nowText} in the 4th${clk}`, 0xf59e0b));
}

async function postLeadChange(sc, streams, trailTeam, htMargin) {
  const clk = sc.clock ? ` · ${sc.clock} to play` : "";
  await sendDiscord(mention() + "🚨 **LEAD CHANGE — the comeback is complete!**",
    gameEmbed(sc, streams, `**${trailTeam}** trailed ${htMargin} at the half and just TOOK THE LEAD${clk}`, 0x16a34a));
}

// Fire a one-off test alert through the CONFIGURED webhook and report the result,
// so we can confirm the Discord integration end to end without a real close game.
export async function sendTestAlert() {
  if (!DISCORD_WEBHOOK) return { configured: false };
  const embed = gameEmbed(
    { away: "San Jose State", home: "Stanford", awayScore: 21, homeScore: 24, clock: "2:00" },
    [{ coach: "Tev", url: "https://twitch.tv/tevg_32" }],
    "3 apart heading into the 4th — **this is a test, ignore**", 0xe11d48);
  try {
    const r = await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "🔥 **CLOSE GAME — test alert (ignore)**", embeds: [embed] }),
    });
    const body = await r.text().catch(() => "");
    return { configured: true, status: r.status, ok: r.ok, body: body.slice(0, 200) };
  } catch (e) { return { configured: true, error: e.message }; }
}

// Detect, once per game and league-wide, a confirmed dynasty game that either
// (a) has staged a multi-score comeback by the 4th (upset brewing), or
// (b) is simply within one score entering the 4th. Head-to-head streams collapse
// to one matchup key, so it pings once. The halftime margin is snapshotted from
// the score history — no team records needed.
async function fireGameAlerts(liveByLogin) {
  if (!DISCORD_WEBHOOK) return;
  const games = new Map(); // key -> { rep, streams:[{coach,url}] }
  for (const [login, st] of liveByLogin) {
    const sc = scores[login];
    // Only real, confirmed dynasty games with a STABLE, confirmed state. This is
    // the guard that prevents a close-game/4th alert firing off the first read
    // before the score and quarter have settled.
    if (!sc || !sc.dynastyConfirmed || !sc.confirmed) continue;
    const key = matchupKey(sc);
    let g = games.get(key);
    if (!g) { g = { rep: sc, streams: [] }; games.set(key, g); }
    g.streams.push({ coach: st.coach || sc.coach || login, url: st.url || `https://twitch.tv/${login}` });
    if (hasBothScores(sc) && !hasBothScores(g.rep)) g.rep = sc; // prefer a full read as representative
  }
  for (const [key, g] of games) {
    const sc = g.rep, q = sc.quarter || null;
    const stt = alertState[key] || (alertState[key] = { q: null, fired: {} });
    const rank = QRANK[q] || 0, prevRank = QRANK[stt.q] || 0;
    // a new game of the same matchup (quarter regressed) resets everything
    if (q && stt.q && rank < prevRank - 0.4) { stt.fired = {}; stt.htDone = false; stt.trailLed = false; }
    if (stt.q === null) {
      // baseline on first sight — never ping on boot. If we're first seeing the
      // game AT halftime, still grab the halftime score for comeback math.
      if (q === "HALF" && hasBothScores(sc)) { stt.htDone = true; stt.htAway = sc.awayScore; stt.htHome = sc.homeScore; }
      stt.q = q; continue;
    }

    // snapshot the halftime score: at the HALF read, or the first time we cross
    // out of the 1st half (covers streams where HALF itself never reads cleanly)
    if (!stt.htDone && hasBothScores(sc) && (q === "HALF" || (prevRank < 2.5 && rank >= 2.5))) {
      stt.htDone = true; stt.htAway = sc.awayScore; stt.htHome = sc.homeScore; stt.trailLed = false;
    }

    // one big ping at the transition into the 4th: comeback wins over plain close
    if (q === "4TH" && stt.q !== "4TH" && !stt.fired.big && hasBothScores(sc)) {
      stt.fired.big = true;
      const margin = Math.abs(sc.awayScore - sc.homeScore);
      let sent = false;
      if (stt.htDone) {
        const htMargin = Math.abs(stt.htAway - stt.htHome);
        const htTie = stt.htAway === stt.htHome;
        const homeLedAtHalf = stt.htHome > stt.htAway;
        if (!htTie && htMargin >= COMEBACK_MIN) {
          // deficit NOW for the team that trailed at half (negative => they now lead)
          const trailAway = !homeLedAtHalf ? false : true; // away trailed if home led
          const trailNow = trailAway ? (sc.homeScore - sc.awayScore) : (sc.awayScore - sc.homeScore);
          if (trailNow <= CLOSE_MARGIN) {
            const trailTeam = resolveTeam(trailAway ? sc.away : sc.home) || (trailAway ? sc.away : sc.home) || "They";
            const nowText = trailNow < 0 ? "now IN FRONT" : (trailNow === 0 ? "now level" : `now within ${trailNow}`);
            await postComeback(sc, g.streams, trailTeam, htMargin, nowText);
            sent = true;
            if (trailNow < 0) stt.trailLed = true; // already announced in front — don't also fire lead-change
          }
        }
      }
      if (!sent && margin <= CLOSE_MARGIN) await postCloseGame(sc, g.streams, margin);
      if (sent || margin <= CLOSE_MARGIN) stt.fired.close = true; // closeness already announced
    }

    // One-score game in the 4th/OT, fired once — catches games that TIGHTEN to
    // within a score after the quarter began (or that the server first saw mid-4th
    // after a restart, so the transition ping above was missed).
    if ((q === "4TH" || q === "OT") && hasBothScores(sc) && !stt.fired.close) {
      const m = Math.abs(sc.awayScore - sc.homeScore);
      if (m <= CLOSE_MARGIN) { stt.fired.close = true; await postCloseGame(sc, g.streams, m); }
    }

    // second, opt-in ping: the half-underdog TAKES THE LEAD during the 4th/OT.
    // Fires once, only when it wasn't already leading (so it doesn't duplicate the
    // "now IN FRONT" comeback ping fired at the top of the 4th).
    if (stt.htDone && hasBothScores(sc)) {
      const htMargin = Math.abs(stt.htAway - stt.htHome);
      const homeLedAtHalf = stt.htHome > stt.htAway;
      if (stt.htAway !== stt.htHome && htMargin >= LEAD_CHANGE_MIN) {
        const trailAway = homeLedAtHalf; // away trailed at half if home led
        const trailLeadsNow = trailAway ? (sc.awayScore > sc.homeScore) : (sc.homeScore > sc.awayScore);
        if ((q === "4TH" || q === "OT") && trailLeadsNow && !stt.trailLed && !stt.fired.lead) {
          stt.fired.lead = true;
          const trailTeam = resolveTeam(trailAway ? sc.away : sc.home) || (trailAway ? sc.away : sc.home) || "They";
          await postLeadChange(sc, g.streams, trailTeam, htMargin);
        }
        stt.trailLed = trailLeadsNow; // remember lead state across ticks (also for 3rd-qtr leads)
      }
    }
    stt.q = q;
  }
}

// Is the bug now showing a DIFFERENT game than the one we are tracking on this stream?
// Coaches stream for hours and play several games (they have a team in each dynasty),
// so one stream session is many games. A new game needs two things together:
// different school(s) on the bug AND a regression (score/quarter went backwards, or the
// last game was already over). That pairing keeps a garbled name from splitting a live game.
// A rematch of the same two teams is caught by "last game over + 1st quarter + lower score".
function detectNewGame(login, prev, r) {
  const pa = schoolName(r.away), ph = schoolName(r.home);
  const la = schoolName(prev.away), lh = schoolName(prev.home);
  const changed = !!((pa && la && pa !== la) || (ph && lh && ph !== lh));
  const lowered = (r.awayScore != null && prev.awayScore != null && r.awayScore < prev.awayScore) ||
                  (r.homeScore != null && prev.homeScore != null && r.homeScore < prev.homeScore);
  const rq = QRANK[r.quarter] || 0, pq = QRANK[prev.quarter] || 0;
  const backwards = lowered || (rq && pq && rq < pq - 0.4);
  const sameTeamsRestart = !!prev.gameOver && r.quarter === "1ST" && lowered;
  if ((changed && (backwards || prev.gameOver)) || sameTeamsRestart) {
    const key = `${pa}|${ph}|${r.quarter}`;
    const p = gamePend[login];
    gamePend[login] = (p && p.k === key) ? { k: key, n: p.n + 1 } : { k: key, n: 1 };
    if (gamePend[login].n >= NEW_GAME_CONFIRM) { gamePend[login] = null; return changed ? "teams changed" : "rematch"; }
  } else {
    gamePend[login] = null;
  }
  return null;
}

// Read one live stream and fold the result into its score row.
async function processStream(login, st, frameFor) {
  const complete = x => x && x.ok && x.awayScore != null && x.homeScore != null;
  const acceptable = x => x && x.ok && (complete(x) || (x.confidence ?? 0) >= MIN_CONF);
  // Read; if the read is missed/incomplete, RETRY IMMEDIATELY (don't wait a
  // whole interval) until we collect a usable read or hit the retry cap.
  let r = await readOne(login, frameFor ? frameFor(login) : null);
  for (let t = 0; t < MISS_RETRIES && !acceptable(r) && !frameFor; t++) r = await readOne(login, null);
  if (!acceptable(r)) return; // menu/replay/cutscene: keep the last reading (staleness handled on read)

  const nowIso = new Date().toISOString();
  const prev0 = scores[login];
  const sameSession = !!prev0 && prev0.startedAt === (st.startedAt || null);
  let prev = sameSession ? prev0 : null;
  let gameNo = sameSession ? (prev0.gameNo || 1) : 1;
  // The stream restarted before we noticed it drop: bank the game it was in.
  if (prev0 && !sameSession) { bankGame(login, prev0); resetPend(login); }

  // ---- a NEW game on the same stream? bank the old one, start fresh ----
  if (prev) {
    const why = detectNewGame(login, prev, r);
    if (why) { console.log(`new game on ${login} (${why})`); bankGame(login, prev); prev = null; gameNo += 1; resetPend(login); }
  }

  // ---- the last game already got its FINAL: hold it frozen until a new game starts ----
  if (prev && prev.gameOver) {
    const live = r.quarter && r.quarter !== "FINAL" && r.clock && r.clock !== "0:00";
    const reopen = live ? (prev.reopenReads || 0) + 1 : 0;
    if (reopen < 3) { scores[login] = { ...prev, updatedAt: nowIso, reopenReads: reopen }; return; }
    // three live-clock reads in a row: that FINAL was a misread, the game is still on
    console.log(`reopening ${login}: FINAL was a misread`);
    removeFinal(prev.finalId);
    prev = { ...prev, gameOver: false, finalId: null, finalReads: 0, reopenReads: 0, finalAt: null };
  }

  let a = r.awayScore, h = r.homeScore, q = r.quarter;
  // canonical school names ("Michigan State"), not raw OCR ("ICHIGONSTATE")
  let away = schoolName(r.away) || r.away, home = schoolName(r.home) || r.home;

  if (prev) {
    // Apparent score RESET (a read lower than stored)? Don't blindly keep the old
    // value and don't trust one low read either: pull a big batch of frames and
    // re-sync only if they agree. If the frames show a fresh 1st quarter after the
    // old game was deep in progress, that is a new game, not a misread.
    const wouldDrop = (a != null && prev.awayScore != null && a < prev.awayScore) ||
                      (h != null && prev.homeScore != null && h < prev.homeScore);
    let startedNew = false;
    if (wouldDrop && !frameFor) {
      const rc = await readOne(login, null, RESET_CONFIRM_FRAMES);
      if (complete(rc) && (rc.confidence ?? 0) >= RESET_CONFIRM_CONF) {
        if (rc.quarter === "1ST" && (QRANK[prev.quarter] || 0) >= 2) {
          console.log(`new game on ${login} (score reset to 1st quarter)`);
          bankGame(login, prev); prev = null; gameNo += 1; resetPend(login);
          r = rc; a = rc.awayScore; h = rc.homeScore; q = rc.quarter;
          away = schoolName(rc.away) || rc.away; home = schoolName(rc.home) || rc.home;
          startedNew = true;
        } else {
          a = rc.awayScore; h = rc.homeScore; // confident re-sync (a misread had inflated the score)
          if (rc.quarter) q = rc.quarter;
          if (rc.away) away = schoolName(rc.away) || rc.away;
          if (rc.home) home = schoolName(rc.home) || rc.home;
          console.log(`score re-synced ${login}: ${a}-${h} (${rc.frames}f)`);
        }
      } else { a = prev.awayScore; h = prev.homeScore; } // not confident: keep prior
    } else {
      // A blank/low single read never lowers the score.
      if (a == null || (prev.awayScore != null && a < prev.awayScore)) a = prev.awayScore;
      if (h == null || (prev.homeScore != null && h < prev.homeScore)) h = prev.homeScore;
    }
    if (!startedNew) {
      // Football legality: a jump no sequence of scoring plays could produce in the
      // time elapsed (a lone "27" for a "7") is held until it repeats, so one
      // systematic misread can't become the floor for the rest of the game.
      const pa = prev.awayScore, ph = prev.homeScore;
      if (pa != null && ph != null && a != null && h != null && (a !== pa || h !== ph) && !(wouldDrop && !frameFor)) {
        const elapsed = (Date.now() - new Date(prev.updatedAt).getTime()) / 1000;
        if (plausibleJump(a - pa, h - ph, elapsed)) jumpPend[login] = null;
        else {
          const p = jumpPend[login];
          const n = (p && p.a === a && p.h === h) ? p.n + 1 : 1;
          if (n >= JUMP_CONFIRM) jumpPend[login] = null;               // repeated: believe it
          else { jumpPend[login] = { a, h, n }; a = pa; h = ph; }       // hold the prior score
        }
      } else if (a === pa && h === ph) jumpPend[login] = null;
    }
  }

  if (prev) {
    // Quarter changes require confirmation across CONSECUTIVE read cycles. A single
    // misread of the tiny quarter box used to advance-and-stick, locking games in the
    // 4th. Any change (forward, a leap, or correcting a stuck value) must repeat for N
    // cycles before we commit. Blank reads hold as-is.
    if (!q) {
      q = prev.quarter; qPend[login] = null;
    } else if (q === prev.quarter) {
      qPend[login] = null;
    } else {
      const cRank = QRANK[prev.quarter] || 0, rRank = QRANK[q] || 0;
      const need = (rRank > cRank && (rRank - cRank) <= 1) ? QCONFIRM_STEP : QCONFIRM_JUMP;
      const p = qPend[login];
      qPend[login] = (p && p.q === q) ? { q, n: p.n + 1 } : { q, n: 1 };
      if (qPend[login].n >= need) qPend[login] = null; // confirmed: adopt q
      else q = prev.quarter;                            // hold until confirmed
    }
    // Keep a verified team name locked against garbles. Release it only when a
    // DIFFERENT verified school is read in TWO consecutive cycles (a real opponent
    // change), so a single end-of-game garble can't flip a locked name.
    const holdLock = (sideKey, cur, locked) => {
      const lk = resolveAny(locked);
      if (!lk) return cur;
      const rc = resolveAny(cur);
      const k = login + sideKey;
      if (!rc || rc === lk) { namePend[k] = null; return locked; }
      const p = namePend[k];
      namePend[k] = (p && p.v === rc) ? { v: rc, n: p.n + 1 } : { v: rc, n: 1 };
      if (namePend[k].n >= NAME_CONFIRM) { namePend[k] = null; return cur; }
      return locked;
    };
    away = holdLock("|a", away, prev.away);
    home = holdLock("|h", home, prev.home);
  } else {
    // first read of a game: no pending quarter/name carryover
    qPend[login] = null; jumpPend[login] = null;
    delete namePend[login + "|a"]; delete namePend[login + "|h"];
  }

  // sticky: once a read shows one of the coach's teams, stay confirmed for the game,
  // and lock which dynasty (rebuild vs fivestar) it is plus which of the coach's two teams
  const match = confirmDynasty(r, st.teams);
  const confirmed = prev?.dynastyConfirmed || !!match;
  const dynasty = prev?.dynasty || (match ? match.dynasty : null);
  const teamName = prev?.team || (match ? match.team : (st.team || null));

  // Whole-game history: only FRESH, complete, confident reads that AGREE with the
  // committed (legality-checked) score, stored with canonical names.
  let hist = (prev && Array.isArray(prev.history)) ? prev.history : [];
  const rawAway = schoolName(r.away), rawHome = schoolName(r.home);
  if (complete(r) && (r.confidence ?? 0) >= HISTORY_MIN_CONF && rawAway && rawHome &&
      r.awayScore === a && r.homeScore === h) {
    hist = hist.concat([{ a: r.awayScore, h: r.homeScore, aw: rawAway, hm: rawHome,
      q: r.quarter || null, conf: r.confidence ?? 0, ts: nowIso }]);
    if (hist.length > HISTORY_MAX) hist = hist.slice(-HISTORY_MAX);
  }

  // --- STABILITY / CONFIRMATION: a game must be read consistently for a few cycles
  // before its state counts. The UI shows "Reading..." and no alert fires until then.
  const firstSeenAt = prev ? (prev.firstSeenAt || nowIso) : nowIso;
  let goodReads = prev ? (prev.goodReads || 0) : 0;
  if (complete(r)) goodReads += 1;
  const qStableN = (prev && q && q === prev.quarter) ? (prev.qStableN || 0) + 1 : 1;
  const ageMs = Date.now() - new Date(firstSeenAt).getTime();
  const namesOK = !!(resolveAny(away) && resolveAny(home));
  const stable = goodReads >= STABLE_MIN_READS && ageMs >= STABLE_MIN_MS && a != null && h != null;
  const qConfirmed = !!q && qStableN >= QSTABLE_MIN;

  // FINAL on the bug: read it this many cycles in a row (and only after the 3rd quarter)
  let finalReads = prev ? (prev.finalReads || 0) : 0;
  if (r.quarter === "FINAL" && a != null && h != null) finalReads += 1;
  else if (r.quarter && r.quarter !== "FINAL") finalReads = 0;

  const row = {
    ...r, away, home, awayScore: a, homeScore: h, quarter: q,
    source: "cv", updatedAt: nowIso, history: hist,
    coach: st.coach || null, team: teamName, dynasty, startedAt: st.startedAt || null,
    dynastyConfirmed: !!confirmed, gameNo,
    firstSeenAt, goodReads, qStableN,
    stable, qConfirmed, confirmed: stable && qConfirmed && namesOK,
    finalReads, gameOver: false, finalId: null, reopenReads: 0, finalAt: null,
  };

  // The game is over the moment the bug says FINAL: lock the final now instead of
  // waiting for the stream to drop (often 40+ minutes later, from a post-game menu).
  if (finalReads >= FINAL_CYCLES && (QRANK[q] || 0) >= 3 && confirmed && namesOK && a != null && h != null) {
    archiveFinal(login, row, "cv-final");
    row.gameOver = true; row.finalId = finalIdFor(login, row); row.finalAt = nowIso; row.quarter = "FINAL";
  }
  scores[login] = row;
}

// A game that is live again isn't final. Drop a final whose own game id is live, or a
// stream-drop final (not a FINAL-on-the-bug final) whose matchup is live again within a
// short window (the stream flickered and came back).
function undoPrematureFinals(liveByLogin) {
  const liveMatchups = new Set(), liveIds = new Set();
  for (const login of liveByLogin.keys()) {
    const sc = scores[login];
    if (!sc || sc.gameOver) continue;
    liveIds.add(finalIdFor(login, sc));
    if (sc.awayScore != null || sc.homeScore != null) liveMatchups.add(pairKey(sc.away, sc.home));
  }
  const now = Date.now(), before = finals.length;
  finals = finals.filter(f => {
    if (liveIds.has(f.id)) return false;
    if (f.source === "cv" && liveMatchups.has(pairKey(f.away, f.home)) &&
        now - new Date(f.endedAt).getTime() < PREMATURE_FINAL_MS) return false;
    return true;
  });
  if (finals.length !== before) persistFinals();
}

// A CONFIRMED dynasty stream missing for a few Twitch snapshots = stream over -> bank
// its last game. One missed snapshot is tolerated (transient Twitch drop). Misses are
// counted per Twitch snapshot, not per score tick, so a 25s tick against a 45s poll
// can't double-count one missing snapshot.
function archiveEndedStreams(liveByLogin, snapshotAt) {
  const newSnap = !snapshotAt || snapshotAt !== lastMissSnap;
  if (snapshotAt) lastMissSnap = snapshotAt;
  for (const login of Object.keys(scores)) {
    if (liveByLogin.has(login)) { misses[login] = 0; continue; }
    if (newSnap) misses[login] = (misses[login] || 0) + 1;
    if ((misses[login] || 0) < ARCHIVE_AFTER_MISSES) continue;
    bankGame(login, scores[login]);
    delete scores[login];
    delete misses[login];
    resetPend(login);
  }
}

// Update scores for all currently-live on-dynasty streams.
export async function updateScores(liveStreams, { frameFor, snapshotAt } = {}) {
  const liveByLogin = new Map(
    liveStreams.filter(s => s.onDynasty).map(s => [s.twitch.toLowerCase(), s])
  );
  // never overwrite a manual correction with a camera read
  const queue = [...liveByLogin.keys()].filter(l => scores[l]?.source !== "manual");

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async login => {
      try { await processStream(login, liveByLogin.get(login) || {}, frameFor); }
      catch (e) { console.error(`score read failed for ${login}:`, e.message); /* keep prior reading */ }
    }));
  }

  // Ping Discord once when a confirmed dynasty game turns into a close 4th quarter.
  try { await fireGameAlerts(liveByLogin); } catch (e) { console.error("alert error:", e.message); }
  undoPrematureFinals(liveByLogin);
  archiveEndedStreams(liveByLogin, snapshotAt);
  persist();
}

// Attach score info onto the live stream objects for /api/live.
export function decorate(streams) {
  const now = Date.now();
  return streams.map(s => {
    const sc = scores[s.twitch.toLowerCase()];
    if (!sc) return s;
    if (sc.gameOver && sc.finalAt && now - new Date(sc.finalAt).getTime() > 10 * 60000) return s; // it's in Finals now
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
  let running = false;
  const tick = async () => {
    if (running) return; // never let a slow cycle pile up on top of another (memory guard)
    running = true;
    try {
      const snap = getLiveStreams();
      const streams = Array.isArray(snap) ? snap : (snap.streams || []);
      await updateScores(streams, { snapshotAt: Array.isArray(snap) ? null : snap.updatedAt });
    }
    catch (e) { console.error("score loop error:", e.message); }
    finally { running = false; }
  };
  tick();
  setInterval(tick, INTERVAL);
}
