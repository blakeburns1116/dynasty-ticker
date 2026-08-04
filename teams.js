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

const norm = s => (s || "").toString().toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

// Does an OCR'd team string refer to `teamName`?
// Match only when the OCR text EQUALS an alias, or CONTAINS a full alias (>=4 chars).
// We never match on the alias containing a fragment of the OCR text — that caused
// false hits like "Florida" matching "Florida International", or "Tulsa"/"Tulane".
export function matchesTeam(ocrText, teamName) {
  const o = norm(ocrText);
  if (!o) return false;
  const aliases = TEAM_ALIASES[teamName] || [norm(teamName)];
  return aliases.some(a => a === o || (a.length >= 4 && o.includes(a)));
}

// Confirm a scoreboard read belongs to a coach's dynasty team.
export function scoreConfirmsTeam(score, teamName) {
  if (!score) return false;
  return matchesTeam(score.away, teamName) || matchesTeam(score.home, teamName);
}
