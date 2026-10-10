// teams.js — match an OCR'd scoreboard team name to a roster team.
// Used to confirm a stream is THIS dynasty: a coach only goes live once the
// scoreboard shows their assigned team as one of the two sides.

export const TEAM_ALIASES = {
  "App State":            ["app state", "appalachian state", "appalachian", "appst", "app"],
  "Ball State":           ["ball state", "ball st", "balst", "ball"],
  "Coastal Carolina":     ["coastal carolina", "coastal", "ccu"],
  "Colorado State":       ["colorado state", "colorado st", "colost", "csu"],
  "East Carolina":        ["east carolina", "ecu"],
  "Florida Atlantic":     ["florida atlantic", "fla atlantic", "fla atl", "fau"],
  "Florida International": ["florida international", "fla international", "fla intl", "fiu"],
  "Fresno State":         ["fresno state", "fresno", "fres"],
  "Georgia Southern":     ["georgia southern", "ga southern", "ga so", "gasou", "gaso"],
  "Jacksonville State":   ["jacksonville state", "jax state", "jvst", "jax"],
  "JMU":                  ["james madison", "jmu"],
  "Liberty":              ["liberty", "lib"],
  "Louisiana":            ["louisiana", "ragin cajuns", "lafayette", "ull"],
  "Miami (OH)":           ["miami oh", "miami ohio", "miamioh", "redhawks", "moh"],
  "Rice":                 ["rice"],
  "Sacramento State":     ["sacramento state", "sac state", "sacst", "sacramento"],
  "San Jose State":       ["san jose state", "san jose", "sjsu"],
  "Southern Miss":        ["southern miss", "southern mississippi", "so miss", "s miss", "usm"],
  "Temple":               ["temple", "tem"],
  "Texas State":          ["texas state", "texas st", "txst", "txstate"],
  "Toledo":               ["toledo", "tol"],
  "Tulane":               ["tulane"],
  "Tulsa":                ["tulsa"],
  "Utah State":           ["utah state", "utah st", "usu"],
  "UTSA":                 ["utsa", "texas san antonio", "texas-san antonio"],
  "Washington State":     ["washington state", "wazzu", "wash state", "wash st", "wsu"],
  "Wyoming":              ["wyoming", "wyo"],

  // --- 5-star dynasty ("5 Stars") roster teams. Order matters: the more specific
  // Texas schools are listed before "Texas" so a read of "TEXAS A&M"/"TEXAS TECH"
  // resolves to them, not to Texas. Miami (OH) is defined above, before "Miami".
  "Ohio State":     ["ohio state", "ohiostate", "ohio st", "osu"],
  "Ole Miss":       ["ole miss", "olemiss", "mississippi"],
  "Indiana":        ["indiana", "ind"],
  "Clemson":        ["clemson", "clem"],
  "Georgia":        ["georgia", "uga"],
  "Texas A&M":      ["texas a&m", "texas am", "texasam", "tamu", "texas a and m"],
  "Texas Tech":     ["texas tech", "texastech", "ttu"],
  "Florida":        ["florida", "fla", "uf"],
  "SMU":            ["smu", "southern methodist"],
  "Oklahoma":       ["oklahoma", "okla", "ou"],
  "Nebraska":       ["nebraska", "neb", "huskers"],
  "USC":            ["usc", "southern cal", "southern california"],
  "Alabama":        ["alabama", "bama", "ala", "crimson tide"],
  "Notre Dame":     ["notre dame", "notredame", "irish", "nd"],
  "Michigan":       ["michigan", "mich"],
  "Miami":          ["miami", "miami fl", "miamifl", "hurricanes", "canes"],
  "Florida State":  ["florida state", "floridastate", "fla state", "fla st", "fsu"],
  "LSU":            ["lsu", "louisiana state"],
  "Oregon":         ["oregon", "ore", "ducks"],
  "Penn State":     ["penn state", "pennstate", "penn st", "psu"],
  "Tennessee":      ["tennessee", "tenn", "vols"],
  "Texas":          ["texas", "longhorns", "tex"],
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
// Similarity that ignores a shared trailing "state" so different "X State" schools
// (Miss State vs Wash State) don't collide, while a garbled state name still matches
// its real school (Washingtn State -> Washington State).
const fsim = (o, a) => {
  if (o.endsWith("state") && a.endsWith("state")) {
    const oc = o.slice(0, -5), ac = a.slice(0, -5);
    return (oc.length >= 3 && ac.length >= 3) ? sim(oc, ac) : 0;
  }
  return sim(o, a);
};

// Every other FBS school (normalized), so the server can tell when an OCR'd name
// is a real, "certified" school and lock it in. Mirrors the color map in the UI.
const FBS_NAMES = [
  "alabama","arkansas","auburn","florida","georgia","kentucky","lsu","mississippistate",
  "missouri","oklahoma","olemiss","mississippi","southcarolina","tennessee","texas","texasam",
  "vanderbilt","illinois","indiana","iowa","maryland","michigan","michiganstate","minnesota",
  "nebraska","northwestern","ohiostate","oregon","pennstate","purdue","rutgers","ucla","usc",
  "washington","wisconsin","arizona","arizonastate","baylor","byu","cincinnati","colorado",
  "houston","iowastate","kansas","kansasstate","oklahomastate","tcu","texastech","ucf","utah",
  "westvirginia","bostoncollege","california","clemson","duke","floridastate","georgiatech",
  "louisville","miami","ncstate","northcarolina","pittsburgh","smu","stanford","syracuse",
  "virginia","virginiatech","wakeforest","notredame","uconn","umass","army","navy","airforce",
  "boisestate","memphis","southflorida","northtexas","utep","uab","charlotte","marshall",
  "olddominion","westernkentucky","middletennessee","newmexicostate","samhouston","kennesawstate",
  "georgiastate","southalabama","troy","arkansasstate","ulmonroe","akron","bowlinggreen","buffalo",
  "centralmichigan","easternmichigan","kentstate","northernillinois","ohio","westernmichigan",
  "nevada","unlv","newmexico","sandiegostate","hawaii","oregonstate",
  "louisianatech","delaware","missouristate",
  // alternate on-screen name forms so the lock recognizes them as real schools
  "connecticut","massachusetts","louisianamonroe","lamonroe","latech","mtsu",
  "westernkentucky","samhoustonstate","northcarolinastate","southerncalifornia",
  "salabama","wkentucky","emichigan","cmichigan","wmichigan","nillinois",
  "missstate","scarolina","ncarolina",
];

// Display names for FBS schools (same names the page's color map uses), and
// alternate on-screen spellings that point at a base key.
export const FBS_DISPLAY = {
  "alabama": "Alabama",
  "arkansas": "Arkansas",
  "auburn": "Auburn",
  "florida": "Florida",
  "georgia": "Georgia",
  "kentucky": "Kentucky",
  "lsu": "LSU",
  "mississippistate": "Mississippi State",
  "missouri": "Missouri",
  "oklahoma": "Oklahoma",
  "olemiss": "Ole Miss",
  "southcarolina": "South Carolina",
  "tennessee": "Tennessee",
  "texas": "Texas",
  "texasam": "Texas A&M",
  "vanderbilt": "Vanderbilt",
  "illinois": "Illinois",
  "indiana": "Indiana",
  "iowa": "Iowa",
  "maryland": "Maryland",
  "michigan": "Michigan",
  "michiganstate": "Michigan State",
  "minnesota": "Minnesota",
  "nebraska": "Nebraska",
  "northwestern": "Northwestern",
  "ohiostate": "Ohio State",
  "oregon": "Oregon",
  "pennstate": "Penn State",
  "purdue": "Purdue",
  "rutgers": "Rutgers",
  "ucla": "UCLA",
  "usc": "USC",
  "washington": "Washington",
  "wisconsin": "Wisconsin",
  "arizona": "Arizona",
  "arizonastate": "Arizona State",
  "baylor": "Baylor",
  "byu": "BYU",
  "cincinnati": "Cincinnati",
  "colorado": "Colorado",
  "houston": "Houston",
  "iowastate": "Iowa State",
  "kansas": "Kansas",
  "kansasstate": "Kansas State",
  "oklahomastate": "Oklahoma State",
  "tcu": "TCU",
  "texastech": "Texas Tech",
  "ucf": "UCF",
  "utah": "Utah",
  "westvirginia": "West Virginia",
  "bostoncollege": "Boston College",
  "california": "California",
  "clemson": "Clemson",
  "duke": "Duke",
  "floridastate": "Florida State",
  "georgiatech": "Georgia Tech",
  "louisville": "Louisville",
  "miami": "Miami",
  "ncstate": "NC State",
  "northcarolina": "North Carolina",
  "pittsburgh": "Pittsburgh",
  "smu": "SMU",
  "stanford": "Stanford",
  "syracuse": "Syracuse",
  "virginia": "Virginia",
  "virginiatech": "Virginia Tech",
  "wakeforest": "Wake Forest",
  "notredame": "Notre Dame",
  "uconn": "UConn",
  "umass": "UMass",
  "army": "Army",
  "navy": "Navy",
  "airforce": "Air Force",
  "boisestate": "Boise State",
  "memphis": "Memphis",
  "southflorida": "South Florida",
  "northtexas": "North Texas",
  "utep": "UTEP",
  "uab": "UAB",
  "charlotte": "Charlotte",
  "marshall": "Marshall",
  "olddominion": "Old Dominion",
  "westernkentucky": "Western Kentucky",
  "middletennessee": "Middle Tennessee",
  "newmexicostate": "New Mexico State",
  "samhouston": "Sam Houston",
  "kennesawstate": "Kennesaw State",
  "georgiastate": "Georgia State",
  "southalabama": "South Alabama",
  "troy": "Troy",
  "arkansasstate": "Arkansas State",
  "ulmonroe": "UL Monroe",
  "akron": "Akron",
  "bowlinggreen": "Bowling Green",
  "buffalo": "Buffalo",
  "centralmichigan": "Central Michigan",
  "easternmichigan": "Eastern Michigan",
  "kentstate": "Kent State",
  "northernillinois": "Northern Illinois",
  "ohio": "Ohio",
  "westernmichigan": "Western Michigan",
  "nevada": "Nevada",
  "unlv": "UNLV",
  "newmexico": "New Mexico",
  "sandiegostate": "San Diego State",
  "hawaii": "Hawaii",
  "oregonstate": "Oregon State",
  "louisianatech": "Louisiana Tech",
  "delaware": "Delaware",
  "missouristate": "Missouri State",
};

const FBS_ALT = {
  "mississippi": "olemiss",
  "connecticut": "uconn",
  "massachusetts": "umass",
  "louisianamonroe": "ulmonroe",
  "lamonroe": "ulmonroe",
  "latech": "louisianatech",
  "mtsu": "middletennessee",
  "samhoustonstate": "samhouston",
  "northcarolinastate": "ncstate",
  "southerncalifornia": "usc",
  "salabama": "southalabama",
  "wkentucky": "westernkentucky",
  "emichigan": "easternmichigan",
  "cmichigan": "centralmichigan",
  "wmichigan": "westernmichigan",
  "nillinois": "northernillinois",
  "missstate": "mississippistate",
  "scarolina": "southcarolina",
  "ncarolina": "northcarolina",
};

// ---------------------------------------------------------------------------
// Alias tables. Built once.
//
// WHY THIS EXISTS: the old matcher let any read that merely CONTAINED a short
// school name (plus up to 3 extra characters) match that school, so "MICHIGAN ST"
// became Michigan, "FLORIDA ST" became Florida, "MISSISSIPPI ST" became Ole Miss,
// and so on. Now an exact hit on ANY known school (roster or FBS, including the
// "ST" abbreviation of every "X State") always wins, and the slack match is
// refused when the leftover characters look like "ST"/"STATE"/"TECH".
// ---------------------------------------------------------------------------
const stVariant = n => (/state$/.test(n) && n.length > 7 ? n.slice(0, -5) + "st" : null);

function aliasesFor(teamName) {
  const list = (TEAM_ALIASES[teamName] || [teamName]).map(norm).filter(Boolean);
  const set = new Set([norm(teamName), ...list]);
  for (const a of [...set]) { const v = stVariant(a); if (v) set.add(v); }
  return [...set];
}

// normalized string -> canonical id (roster display name, or FBS base key)
const KNOWN = new Map();
for (const name of Object.keys(TEAM_ALIASES))
  for (const a of aliasesFor(name)) if (!KNOWN.has(a)) KNOWN.set(a, name);
for (const k of FBS_NAMES) {
  const base = FBS_ALT[k] || k;
  if (!KNOWN.has(k)) KNOWN.set(k, KNOWN.get(base) || base);
  const v = stVariant(k);
  if (v && !KNOWN.has(v)) KNOWN.set(v, KNOWN.get(base) || base);
}
// canonical id of any team string we are asked about (roster name or FBS key)
const canonOf = teamName => KNOWN.get(norm(teamName)) || norm(teamName);

// Leftover characters after an alias that signal a DIFFERENT school ("... ST",
// "... STATE", "... TECH"), so slack containment must not apply.
const blocksSlack = (o, a) => /^(st|tech)/.test(o.replace(a, ""));

// Does an OCR'd team string refer to `teamName`?
// Exact, then guarded slack containment, then a fuzzy fallback (>=0.62 similar).
export function matchesTeam(ocrText, teamName) {
  const o = norm(ocrText);
  if (!o) return false;
  const aliases = aliasesFor(teamName);
  if (aliases.includes(o)) return true;
  // the read is exactly some OTHER known school (or its ST abbreviation): not us
  const ex = KNOWN.get(o);
  if (ex && ex !== canonOf(teamName)) return false;
  const loose =
    aliases.some(a => a.length >= 4 && o.includes(a) && o.length - a.length <= 3 && !blocksSlack(o, a)) ||
    (o.length >= 6 && aliases.some(a => a.length >= 8 && Math.abs(o.length - a.length) <= 2 && !a.startsWith(o) && fsim(o, a) >= 0.62));
  if (!loose) return false;
  // a loose match only counts if no OTHER school explains the read better
  const any = resolveAny(o);
  return !any || any === canonOf(teamName);
}

// Confirm a scoreboard read belongs to a coach's dynasty team.
export function scoreConfirmsTeam(score, teamName) {
  if (!score) return false;
  return matchesTeam(score.away, teamName) || matchesTeam(score.home, teamName);
}

// A coach now has a team in each dynasty ({ rebuild, fivestar }). Since the two
// are always different schools, the team on the scoreboard tells us which league
// this stream is. Returns { dynasty, team } for the first assigned team that
// appears on the bug, or null if neither has been read yet.
export function confirmDynasty(score, teams) {
  if (!score || !teams) return null;
  for (const dynasty of ["rebuild", "fivestar"]) {
    const team = teams[dynasty];
    if (team && scoreConfirmsTeam(score, team)) return { dynasty, team };
  }
  return null;
}

// Map an OCR'd team string to its canonical roster name (or null).
export function resolveTeam(ocrText) {
  const o = norm(ocrText);
  if (!o) return null;
  // exact hit on any known school wins outright (roster -> name, FBS -> not roster)
  const ex = KNOWN.get(o);
  if (ex) return TEAM_ALIASES[ex] ? ex : null;
  // Garble tolerance. Every (school, alias) pair is scored and the BEST one wins,
  // instead of the first slack match: "TEXASAGM" contains "texas" but is far closer
  // to "texas a and m", so it must be Texas A&M, not Texas.
  //   contained alias (<=3 junk chars, not an ST/STATE/TECH tail): a.length / o.length
  //   fuzzy similarity (full names only, similar length):           fsim(o, a) >= 0.62
  let best = null, bs = 0;
  for (const name of Object.keys(TEAM_ALIASES)) {
    for (const a of aliasesFor(name)) {
      let s = 0;
      if (a.length >= 4 && o.includes(a) && o.length - a.length <= 3 && !blocksSlack(o, a)) s = a.length / o.length;
      if (o.length >= 6 && a.length >= 8 && Math.abs(o.length - a.length) <= 2 && !a.startsWith(o)) {
        const f = fsim(o, a);
        if (f >= 0.62 && f > s) s = f;
      }
      if (s > bs) { bs = s; best = name; }
    }
  }
  return best;
}

// Is an OCR'd team string a real, recognizable school (roster OR any FBS team)?
// Returns a canonical id (roster display name, or FBS base key) when recognized,
// else null. Used to LOCK a team name once verified so garbled reads can't overwrite it.
export function resolveAny(ocrText) {
  const roster = resolveTeam(ocrText);
  if (roster) return roster;
  const o = norm(ocrText);
  if (!o) return null;
  const ex = KNOWN.get(o);
  if (ex) return ex;                       // exact FBS school
  const keys = FBS_NAMES.map(k => FBS_ALT[k] || k).filter((k, i, a) => a.indexOf(k) === i);
  // clipped read: the text is the start or end of a known name, and every such
  // name belongs to exactly ONE school ("ICHIGAN", "GEORGIA SOUTH", "TENNESS").
  // Roster aliases count too, so a truncated roster name can't fall through to a
  // lookalike FBS school (GEORGIA SOUTH must not become Georgia State).
  if (o.length >= 5) {
    const owners = new Set();
    for (const [alias, canon] of KNOWN) {
      if (alias.length > o.length && alias.length >= 6 && (alias.startsWith(o) || alias.endsWith(o))) owners.add(canon);
    }
    if (owners.size === 1) return [...owners][0];
  }
  // school name plus a few junk characters ("ALABAMAXX")
  for (const k of keys) if (k.length >= 5 && o.includes(k) && o.length - k.length <= 3 && !blocksSlack(o, k)) return k;
  // fuzzy, accepted only when clearly better than the runner-up
  if (o.length >= 5) {
    let best = null, bs = 0, second = 0;
    for (const k of keys) {
      if (k.length < 6 || Math.abs(o.length - k.length) > 2 || k.startsWith(o)) continue;
      const s = fsim(o, k);
      if (s > bs) { second = bs; bs = s; best = k; } else if (s > second) second = s;
    }
    if (best && bs >= 0.6 && (bs - second) >= 0.08) return best;
  }
  return null;
}

const titleCase = s => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b[a-z]/g, c => c.toUpperCase());

// Canonical display name for an OCR'd string: roster name ("Texas A&M"), FBS
// display name ("Michigan State"), or null when it isn't a recognizable school.
export function schoolName(ocrText) {
  const id = resolveAny(ocrText);
  if (!id) return null;
  if (TEAM_ALIASES[id]) return id;
  return FBS_DISPLAY[id] || titleCase(id);
}
