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
  let best = null, bc = 0;
  for (const [v, c] of m) if (c > bc || (c === bc && best && v.length > best.length)) { bc = c; best = v; }
  return best;
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
  const trust = m => (ok.length >= 3 && m.count < 2) ? null : m.val;
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

// Read one stream: grab GRAB_ATTEMPTS frames spread over a few seconds and return
// the consensus across them, so a replay/menu/blurry/garbled frame is outvoted.
// `frameOverride` lets tests skip grab.sh and read a fixed frame once.
async function readOne(login, frameOverride) {
  if (frameOverride) return readFrame(frameOverride);
  const frame = path.join(os.tmpdir(), `frame_${login}.jpg`);
  const reads = [];
  for (let i = 0; i < GRAB_ATTEMPTS; i++) {
    try {
      await execFileP("bash", [path.join(SCORE_DIR, "grab.sh"), login, frame], { timeout: 30000 });
      const r = await readFrame(frame);
      if (r && r.ok) reads.push(r);
    } catch (e) { /* try the next frame */ }
    if (i < GRAB_ATTEMPTS - 1) await new Promise(res => setTimeout(res, GRAB_GAP_MS));
  }
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
    if (!sc || !sc.dynastyConfirmed) continue;  // only real, confirmed dynasty games
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
        const r = await readOne(login, frameFor ? frameFor(login) : null);
        // accept if both scores clearly read (strong validity), or confidence clears the bar
        const bothScores = r.ok && r.awayScore != null && r.homeScore != null;
        if (r.ok && (bothScores || (r.confidence ?? 0) >= MIN_CONF)) {
          const st = liveByLogin.get(login) || {};
          const prev = scores[login];
          // sticky: once a read shows their team, stay confirmed for the session
          const confirmed = prev?.dynastyConfirmed || scoreConfirmsTeam(r, st.team);
          // Scores never go backwards within a game. Guards against garbage
          // end-of-game camera reads: a lower/blank read keeps the prior value.
          // Quarter is sticky and only advances (1st->2nd->3rd->4th->OT), so once
          // it's captured it stays accurate even on frames where it doesn't read.
          let a = r.awayScore, h = r.homeScore, q = r.quarter;
          let away = r.away, home = r.home;
          if (prev && prev.startedAt === (st.startedAt || null)) {
            // Scores only ever climb within a game, so a lower/blank read is a
            // misread (e.g. "21" clipped to "1") — keep the prior value.
            if (a == null || (prev.awayScore != null && a < prev.awayScore)) a = prev.awayScore;
            if (h == null || (prev.homeScore != null && h < prev.homeScore)) h = prev.homeScore;
            if (!q || (QRANK[q] || 0) < (QRANK[prev.quarter] || 0)) q = prev.quarter;
            // Once a team name is verified as a real school, LOCK it for the rest
            // of the game — later garbled reads can't overwrite "Stanford" etc.
            if (resolveAny(prev.away)) away = prev.away;
            if (resolveAny(prev.home)) home = prev.home;
          }
          scores[login] = {
            ...r, away, home, awayScore: a, homeScore: h, quarter: q,
            source: "cv", updatedAt: new Date().toISOString(),
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
