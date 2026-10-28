// Pulls everything the scoring engine needs from the public FPL API
// and writes it to data/raw.json. Runs inside GitHub Actions.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const BASE = "https://fantasy.premierleague.com/api";
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
const leagueId = process.env.LEAGUE_ID || config.leagueId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, attempt = 1) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (FPL Fraud Detector; github.com)",
        Accept: "application/json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw new Error(`Failed ${url}: ${err.message}`);
    await sleep(1000 * attempt * attempt);
    return get(path, attempt + 1);
  }
}

// Run tasks with limited concurrency so we stay polite to the API
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
      await sleep(120);
    }
  });
  await Promise.all(workers);
  return out;
}

console.log(`Fetching league ${leagueId}...`);
const bootstrap = await get("/bootstrap-static/");
const fixtures = await get("/fixtures/");

const finished = bootstrap.events.filter((e) => e.finished).map((e) => e.id);
const lastGw = finished.length ? Math.max(...finished) : 0;
console.log(`Last finished gameweek: ${lastGw}`);

// League standings (paginated, 50 per page)
let page = 1;
let league = null;
const standings = [];
while (true) {
  const data = await get(`/leagues-classic/${leagueId}/standings/?page_standings=${page}`);
  if (!data) throw new Error(`League ${leagueId} not found`);
  league = data.league;
  standings.push(...data.standings.results);
  if (!data.standings.has_next) break;
  page++;
}
console.log(`${standings.length} managers in ${league.name}`);

const gws = Array.from({ length: lastGw }, (_, i) => i + 1);

const live = {};
await pool(gws, 3, async (gw) => {
  live[gw] = await get(`/event/${gw}/live/`);
});

const entries = {};
await pool(standings, 3, async (s) => {
  const id = s.entry;
  const [info, history, transfers] = await Promise.all([
    get(`/entry/${id}/`),
    get(`/entry/${id}/history/`),
    get(`/entry/${id}/transfers/`),
  ]);
  const start = info?.started_event || 1;
  const picks = {};
  for (const gw of gws) {
    if (gw < start) continue;
    picks[gw] = await get(`/entry/${id}/event/${gw}/picks/`);
    await sleep(60);
  }
  entries[id] = { info, history, transfers, picks };
  console.log(`  ${s.entry_name} done`);
});

// Trim bootstrap to what we use, to keep the file small
const slimBootstrap = {
  events: bootstrap.events.map((e) => ({
    id: e.id,
    name: e.name,
    finished: e.finished,
    is_current: e.is_current,
    deadline_time: e.deadline_time,
    average_entry_score: e.average_entry_score,
    highest_score: e.highest_score,
    most_captained: e.most_captained,
  })),
  teams: bootstrap.teams.map((t) => ({ id: t.id, name: t.name, short_name: t.short_name })),
  elements: bootstrap.elements.map((p) => ({
    id: p.id,
    web_name: p.web_name,
    team: p.team,
    element_type: p.element_type,
    selected_by_percent: p.selected_by_percent,
    now_cost: p.now_cost,
    total_points: p.total_points,
  })),
};

const slimLive = {};
for (const [gw, data] of Object.entries(live)) {
  slimLive[gw] = (data?.elements || []).map((el) => ({
    id: el.id,
    s: {
      minutes: el.stats.minutes,
      goals_scored: el.stats.goals_scored,
      assists: el.stats.assists,
      total_points: el.stats.total_points,
      expected_goals: el.stats.expected_goals,
      expected_assists: el.stats.expected_assists,
    },
  }));
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../data/raw.json", import.meta.url),
  JSON.stringify({
    fetchedAt: new Date().toISOString(),
    leagueId,
    league: { id: league.id, name: league.name },
    lastGw,
    bootstrap: slimBootstrap,
    fixtures: fixtures.map((f) => ({
      event: f.event,
      team_h: f.team_h,
      team_a: f.team_a,
      team_h_difficulty: f.team_h_difficulty,
      team_a_difficulty: f.team_a_difficulty,
      finished: f.finished,
    })),
    standings: standings.map((s) => ({
      entry: s.entry,
      entry_name: s.entry_name,
      player_name: s.player_name,
      rank: s.rank,
      total: s.total,
      event_total: s.event_total,
    })),
    live: slimLive,
    entries,
  })
);
console.log("Saved data/raw.json");
