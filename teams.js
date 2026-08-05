// teams.js — match an OCR'd scoreboard team name to a roster team.
// Used to confirm a stream is THIS dynasty: a coach only goes live once the
// scoreboard shows their assigned team as one of the two sides.

export const TEAM_ALIASES = {
  "App State":            ["app state", "appalachian state", "appalachian", "appst", "app"],
  "Ball State":           ["ball state", "ball st", "balst", "ball"],
  "Coastal Carolina":     ["coastal carolina", "coastal", "ccu"],
  "Colorado State":       ["colorado state", "colorado st", "colost", "csu"],
  "East Carolina":        ["east carolina", "ecu"],
  "Florida Atlantic":     ["florida atlantic", "fau"],
  "Florida International": ["florida international", "fiu"],
  "Fresno State":         ["fresno state", "fresno", "fres"],
  "Georgia Southern":     ["georgia southern", "ga southern", "gasou", "gaso"],
  "Jacksonville State":   ["jacksonville state", "jax state", "jvst", "jax"],
  "JMU":                  ["james madison", "jmu"],
  "Liberty":              ["liberty", "lib"],
  "Louisiana":            ["louisiana", "ragin cajuns", "lafayette", "ull"],
  "Miami (OH)":           ["miami oh", "miami ohio", "miamioh", "redhawks", "moh"],
  "Rice":                 ["rice"],
  "Sacramento State":     ["sacramento state", "sac state", "sacst", "sacramento"],
  "San Jose State":       ["san jose state", "san jose", "sjsu"],
  "Southern Miss":        ["southern miss", "southern mississippi", "usm"],
  "Temple":               ["temple", "tem"],
  "Texas State":          ["texas state", "texas st", "txst", "txstate"],
  "Toledo":               ["toledo", "tol"],
  "Tulane":               ["tulane"],
  "Tulsa":                ["tulsa"],
  "Utah State":           ["utah state", "utah st", "usu"],
  "UTSA":                 ["utsa", "texas san antonio", "texas-san antonio"],
  "Washington State":     ["washington state", "wazzu", "wash state", "wash st", "wsu"],
  "Wyoming":              ["wyoming", "wyo"],
};

// lowercase, drop punctuation AND spaces so "BALLSTATE" matches "ball state"
const norm = s => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

// Levenshtein distance + similarity ratio, to tolerate OCR garble like
// "EASTCARGL" for "east carolina" without matching genuinely different teams.
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const sim = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 0; };

// Does an OCR'd team string refer to `teamName`?
// Exact / full-alias-contained, then a fuzzy fallback (>=0.62 similar) for garbled
// reads. Threshold tuned so lookalikes stay apart (e.g. Texas State vs Texas A&M).
export function matchesTeam(ocrText, teamName) {
  const o = norm(ocrText);
  if (!o) return false;
  const aliases = (TEAM_ALIASES[teamName] || [teamName]).map(norm);
  if (aliases.some(a => a === o || (a.length >= 4 && o.includes(a)))) return true;
  // fuzzy only against full names (>=8 chars) to avoid short-alias lookalikes
  if (o.length >= 6 && aliases.some(a => a.length >= 8 && sim(o, a) >= 0.62)) return true;
  return false;
}

// Confirm a scoreboard read belongs to a coach's dynasty team.
export function scoreConfirmsTeam(score, teamName) {
  if (!score) return false;
  return matchesTeam(score.away, teamName) || matchesTeam(score.home, teamName);
}

// Map an OCR'd team string to its canonical roster name (or null). Lets the
// server build ONE stable matchup key for a head-to-head even when the two
// coaches' streams OCR the names slightly differently.
export function resolveTeam(ocrText) {
  const o = norm(ocrText);
  if (!o) return null;
  // strong: an exact/contained alias wins immediately
  for (const name of Object.keys(TEAM_ALIASES)) {
    const aliases = (TEAM_ALIASES[name] || [name]).map(norm);
    if (aliases.some(a => a === o || (a.length >= 4 && o.includes(a)))) return name;
  }
  // fuzzy: pick the BEST similarity across full-length aliases (avoids the first
  // over-threshold alias winning, e.g. garbled "EXASSTATE" -> Texas State not Jax State)
  if (o.length >= 6) {
    let best = null, bs = 0;
    for (const name of Object.keys(TEAM_ALIASES)) {
      for (const a of (TEAM_ALIASES[name] || [name]).map(norm)) {
        if (a.length < 8) continue;
        const s = sim(o, a);
        if (s > bs) { bs = s; best = name; }
      }
    }
    if (bs >= 0.62) return best;
  }
  return null;
}
