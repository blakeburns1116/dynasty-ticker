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
import { scoreConfirmsTeam, resolveTeam, resolveAny } from "./teams.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCORE_DIR = path.join(__dirname, "score");

const ENABLED = process.env.SCORE_ENABLED === "1";
const INTERVAL = Number(process.env.SCORE_SECONDS || 25) * 1000;
const CONCURRENCY = Number(process.env.SCORE_CONCURRENCY || 1);
const MIN_CONF = Number(process.env.SCORE_MIN_CONFIDENCE || 0.22);
const FRAME_TTL = Number(process.env.SCORE_STALE_SECONDS || 120) * 1000;
// grab up to N frames per read so a replay/menu/blurry moment doesn't lose the score.
// More frames = a stronger per-cycle vote (one garbled frame can't win a majority).
const GRAB_ATTEMPTS = Number(process.env.SCORE_GRAB_ATTEMPTS || 8);
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
let namePend = {}; // login+side -> { v, n } pending team-name change awaiting confirmation
// a locked team name only flips after a different school is read this many cycles
const NAME_CONFIRM = Number(process.env.SCORE_NAME_CONFIRM || 2);
// how many consecutive cycles a NEW quarter must be read before we commit to it.
// One forward step (e.g. 3RD->4TH) is normal, so 2; a leap, a regression, or OT is
// suspicious (usually a misread of the tiny quarter box), so demand 3.
const QCONFIRM_STEP = Number(process.env.SCORE_QCONFIRM_STEP || 2);
const QCONFIRM_JUMP = Number(process.env.SCORE_QCONFIRM_JUMP || 3);

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
// single last frame. Football scores only go up, so each side's final is the
// HIGHEST value that was confirmed by several frames — this rejects both a low
// end-of-game garble (replay/menu/postgame 0-0) and a one-frame spurious spike.
function confirmedFinal(sc) {
  const hist = Array.isArray(sc.history) ? sc.history : [];
  const settled = hist.filter(e => e && e.a != null && e.h != null);
  // highest per-side value seen in >= FINAL_CONFIRM_VOTES frames
  const pick = key => {
    const counts = new Map();
    for (const e of settled) counts.set(e[key], (counts.get(e[key]) || 0) + 1);
    let best = null;
    for (const [v, c] of counts) if (c >= FINAL_CONFIRM_VOTES && (best == null || v > best)) best = v;
    return best;
  };
  let a = pick("a"), h = pick("h");
  // Prefer a scoreline that actually co-occurred at the confirmed peak; otherwise
  // fall back to the per-side confirmed maxes (they meet on the last real play).
  // Thin history (short game / few confident reads) falls back to the live score.
  if (a == null) a = sc.awayScore ?? null;
  if (h == null) h = sc.homeScore ?? null;
  // never report BELOW the last confirmed live score (it's the monotonic peak),
  // but do let history override a live score that a late garble dragged down.
  if (sc.awayScore != null && (a == null || sc.awayScore > a) && settled.length < FINAL_CONFIRM_VOTES) a = sc.awayScore;
  if (sc.homeScore != null && (h == null || sc.homeScore > h) && settled.length < FINAL_CONFIRM_VOTES) h = sc.homeScore;
  // Team NAME by whole-game majority, not the last frame: a garbled end-of-game
  // read that fuzzy-resolved to a real school (e.g. Texas State -> Tennessee) and
  // released the name-lock can't win against hundreds of correct reads.
  const modeName = key => {
    const counts = new Map();
    for (const e of hist) { const v = e && e[key]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    let best = null, bc = 0;
    for (const [v, c] of counts) if (c > bc) { bc = c; best = v; }
    return best;
  };
  const away = modeName("aw"), home = modeName("hm");
  return { awayScore: a, homeScore: h, away, home, votes: settled.length };
}

// move a stream's game into the finals list (deduped by twitch+startedAt).
// Uses the whole-game confirmed final, not just the last live reading.
function archiveFinal(login, sc) {
  const id = `${login}_${sc.startedAt || ""}`;
  const cf = confirmedFinal(sc);
  const away = cf.away || sc.away || null;   // whole-game majority name, else last live
  const home = cf.home || sc.home || null;
  console.log(`archive ${login}: final ${away} ${cf.awayScore}-${cf.homeScore} ${home} ` +
    `(from ${cf.votes} confident reads; last live name was ${sc.away}/${sc.home}, score ${sc.awayScore}-${sc.homeScore})`);
  const rec = {
    id, twitch: login, coach: sc.coach || login, team: sc.team || "",
    away, home,
    awayScore: cf.awayScore ?? null, homeScore: cf.homeScore ?? null,
    endedAt: new Date().toISOString(), source: sc.source || "cv",
  };
  const i = finals.findIndex(f => f.id === id);
  if (i >= 0) finals[i] = { ...finals[i], ...rec, endedAt: finals[i].endedAt };
  else finals.push(rec);
  persistFinals();
}

// Manually add (or upsert) a completed game to the Final board. Used to restore
// finals that were lost, or to log a game the reader never saw.
export function addFinal(data) {
  const away = data.away || null, home = data.home || null;
  const key = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = data.id || `add_${key(away)}_${key(home)}`;
  const rec = {
    id, twitch: data.twitch || id,
    coach: data.coach || "", team: data.team || "",
    away, home, awayScore: num(data.awayScore), homeScore: num(data.homeScore),
    endedAt: new Date().toISOString(), source: "manual",
  };
  const i = finals.findIndex(f => f.id === id);
  if (i >= 0) finals[i] = rec; else finals.push(rec);
  persistFinals();
  return rec;
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
    { timeout: 60000 }
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
async function readOne(login, frameOverride, frames = GRAB_ATTEMPTS) {
  if (frameOverride) return readFrame(frameOverride);
  const prefix = path.join(os.tmpdir(), `frame_${login}`);
  let reads = [];
  try {
    // one stream pull -> N frames (spread ~1s apart) -> one OCR process
    await execFileP("bash", [path.join(SCORE_DIR, "grab.sh"), login, prefix, String(frames)],
      { timeout: Math.max(90000, frames * 4000) });
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
        const complete = x => x && x.ok && x.awayScore != null && x.homeScore != null;
        const acceptable = x => x && x.ok && (complete(x) || (x.confidence ?? 0) >= MIN_CONF);
        // Read; if the read is missed/incomplete, RETRY IMMEDIATELY (don't wait a
        // whole interval) until we collect a usable read or hit the retry cap.
        let r = await readOne(login, frameFor ? frameFor(login) : null);
        for (let t = 0; t < MISS_RETRIES && !acceptable(r) && !frameFor; t++) {
          r = await readOne(login, null);
        }
        if (acceptable(r)) {
          const st = liveByLogin.get(login) || {};
          const prev = scores[login];
          // sticky: once a read shows their team, stay confirmed for the session
          const confirmed = prev?.dynastyConfirmed || scoreConfirmsTeam(r, st.team);
          let a = r.awayScore, h = r.homeScore, q = r.quarter;
          let away = r.away, home = r.home;
          if (prev && prev.startedAt === (st.startedAt || null)) {
            // Apparent score RESET (a read lower than stored)? Don't blindly keep
            // the old value and don't trust one low read either — pull a big batch
            // of frames and re-sync to the true current score only if they agree.
            const wouldDrop = (a != null && prev.awayScore != null && a < prev.awayScore) ||
                              (h != null && prev.homeScore != null && h < prev.homeScore);
            if (wouldDrop && !frameFor) {
              const rc = await readOne(login, null, RESET_CONFIRM_FRAMES);
              if (complete(rc) && (rc.confidence ?? 0) >= RESET_CONFIRM_CONF) {
                a = rc.awayScore; h = rc.homeScore;               // confident re-sync (may drop)
                if (rc.quarter) q = rc.quarter;
                if (rc.away) away = rc.away;
                if (rc.home) home = rc.home;
                console.log(`score re-synced ${login}: ${a}-${h} (${rc.frames}f)`);
              } else {                                            // not confident — keep prior
                a = prev.awayScore; h = prev.homeScore;
              }
            } else {
              // normal: a blank/low single read never lowers the score
              if (a == null || (prev.awayScore != null && a < prev.awayScore)) a = prev.awayScore;
              if (h == null || (prev.homeScore != null && h < prev.homeScore)) h = prev.homeScore;
            }
            // Quarter changes require confirmation across CONSECUTIVE read cycles.
            // A single misread of the tiny quarter box used to advance-and-stick,
            // locking games in the 4th (false "4th quarter" alerts + frozen clock).
            // Now any change — forward, a leap, or correcting a wrong/stuck value —
            // must repeat for N cycles before we commit. Blank reads hold as-is.
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
              else q = prev.quarter;                           // hold until confirmed
            }
            // Keep a verified team name locked against garbles. Release it only when
            // a DIFFERENT verified school is read in TWO consecutive cycles (a real
            // opponent change, e.g. "Arkansas" -> "Houston"), so a single end-of-game
            // garble can't flip a locked name (e.g. Texas State -> Tennessee).
            const holdLock = (sideKey, cur, locked) => {
              const lk = resolveAny(locked);
              if (!lk) return cur;                       // nothing locked yet
              const rc = resolveAny(cur);
              const k = login + sideKey;
              if (!rc || rc === lk) { namePend[k] = null; return locked; } // same/garble: keep
              const p = namePend[k];
              namePend[k] = (p && p.v === rc) ? { v: rc, n: p.n + 1 } : { v: rc, n: 1 };
              if (namePend[k].n >= NAME_CONFIRM) { namePend[k] = null; return cur; } // confirmed change
              return locked;                             // hold lock until confirmed
            };
            away = holdLock("|a", away, prev.away);
            home = holdLock("|h", home, prev.home);
          } else {
            // first read of a new game: no pending quarter/name carryover
            qPend[login] = null; delete namePend[login + "|a"]; delete namePend[login + "|h"];
          }
          const nowIso = new Date().toISOString();
          // Roll the whole-game history forward (reset it when a new game starts on
          // this stream). Log only FRESH complete, confident reads — the raw observed
          // digits — so the final vote is over real observations, not carried-forward
          // monotonic values. archiveFinal() later picks the confirmed peak from this.
          let hist = (prev && prev.startedAt === (st.startedAt || null) && Array.isArray(prev.history)) ? prev.history : [];
          if (complete(r) && (r.confidence ?? 0) >= HISTORY_MIN_CONF &&
              resolveAny(r.away) && resolveAny(r.home)) {
            // store the confirmed/locked display names so the FINAL name is decided
            // by whole-game majority, not the last (possibly garbled) frame.
            hist = hist.concat([{ a: r.awayScore, h: r.homeScore, aw: away, hm: home,
              q: r.quarter || null, conf: r.confidence ?? 0, ts: nowIso }]);
            if (hist.length > HISTORY_MAX) hist = hist.slice(-HISTORY_MAX);
          }
          // --- STABILITY / CONFIRMATION -------------------------------------
          // A game must be read consistently for a few cycles before we treat its
          // state as real. This is what stops "score/quarter/alert off the first
          // noisy read": the UI shows "Reading…" and no alert fires until stable.
          const sameGame = prev && prev.startedAt === (st.startedAt || null);
          const firstSeenAt = sameGame ? (prev.firstSeenAt || nowIso) : nowIso;
          let goodReads = sameGame ? (prev.goodReads || 0) : 0;
          if (complete(r)) goodReads += 1;
          // quarter must persist as the SAME committed value for a few cycles
          let qStableN = (sameGame && q && q === prev.quarter) ? (prev.qStableN || 0) + 1 : 1;
          const ageMs = Date.now() - new Date(firstSeenAt).getTime();
          const namesOK = !!(resolveAny(away) && resolveAny(home));
          const stable = goodReads >= STABLE_MIN_READS && ageMs >= STABLE_MIN_MS && a != null && h != null;
          const qConfirmed = !!q && qStableN >= QSTABLE_MIN;
          const stateConfirmed = stable && qConfirmed && namesOK;
          scores[login] = {
            ...r, away, home, awayScore: a, homeScore: h, quarter: q,
            source: "cv", updatedAt: nowIso, history: hist,
            coach: st.coach || null, team: st.team || null, startedAt: st.startedAt || null,
            dynastyConfirmed: !!confirmed,
            firstSeenAt, goodReads, qStableN,
            stable, qConfirmed, confirmed: stateConfirmed,
          };
        }
        // if not ok (menu/replay), we keep the last reading; staleness handled on read
      } catch (e) {
        // channel dropped, grab failed, etc. — leave prior reading in place
      }
    }));
  }

  // Ping Discord once when a confirmed dynasty game turns into a close 4th quarter.
  try { await fireGameAlerts(liveByLogin); } catch (e) { console.error("alert error:", e.message); }

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
    // Only archive games we actually locked onto (confirmed dynasty + a stable
    // read at some point) so a brief garbled sighting never becomes a "final".
    if (sc.dynastyConfirmed && sc.stable && (sc.awayScore != null || sc.homeScore != null)) archiveFinal(login, sc);
    delete scores[login];
    delete misses[login];
    delete qPend[login];
    delete namePend[login + "|a"]; delete namePend[login + "|h"];
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
  let running = false;
  const tick = async () => {
    if (running) return; // never let a slow cycle pile up on top of another (memory guard)
    running = true;
    try { await updateScores(getLiveStreams()); }
    catch (e) { console.error("score loop error:", e.message); }
    finally { running = false; }
  };
  tick();
  setInterval(tick, INTERVAL);
}
