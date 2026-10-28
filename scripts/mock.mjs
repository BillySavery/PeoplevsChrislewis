// Generates a realistic fake league in the same shape as the FPL API,
// so the site can be previewed before the first real data run.
// Usage: node scripts/mock.mjs  ->  data/raw-demo.json
import { writeFile, mkdir } from "node:fs/promises";

let seed = 566171;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const ri = (a, b) => Math.floor(rand() * (b - a + 1)) + a;
const choice = (arr) => arr[Math.floor(rand() * arr.length)];
const poisson = (l) => {
  let k = 0, p = 1;
  const L = Math.exp(-l);
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
};

const LAST_GW = 9;
const teamNames = [
  ["Arsenal", "ARS"], ["Aston Villa", "AVL"], ["Bournemouth", "BOU"], ["Brentford", "BRE"], ["Brighton", "BHA"],
  ["Burnley", "BUR"], ["Chelsea", "CHE"], ["Crystal Palace", "CRY"], ["Everton", "EVE"], ["Fulham", "FUL"],
  ["Leeds", "LEE"], ["Liverpool", "LIV"], ["Man City", "MCI"], ["Man Utd", "MUN"], ["Newcastle", "NEW"],
  ["Nott'm Forest", "NFO"], ["Sunderland", "SUN"], ["Spurs", "TOT"], ["West Ham", "WHU"], ["Wolves", "WOL"],
];
const teams = teamNames.map(([name, short_name], i) => ({ id: i + 1, name, short_name }));
const strength = teams.map(() => 0.6 + rand() * 0.8);

const surnames = "Okafor Lindqvist Brennan Moreau Haddad Kowalski Silva Achebe Romero Novak Fischer Diallo Kane Rossi Petrov Laurent Mensah Costa Varga Duarte Hughes Berg Tanaka Ferreira Murphy Nkosi Ortega Weber Quinn Blanco Sato Ivanov Keller Adeyemi Bianchi Larsen Mbappe Ndiaye Owusu Pereira Schmidt Toure Vidal Walsh Yilmaz Zielinski Aguero Bakare Castro Dembele Eze Fofana Gallagher Hakimi Ito Jansen Kamara Lukaku Mendy Nunez Olsen Palmer Rice Sancho Tielemans Upamecano Vardy Wirtz Xhaka Yamal Zaha Abbott Barnes Cole Dyer Ellis Foster Grant Hart Irwin Jones Knight Lowe Moss Nash Oakes Price Reid Shaw Tate Vance Wells York Ames Boyd Clay Drew Eaton Frost Gill Hale".split(" ");

const elements = [];
let pid = 1;
for (const t of teams) {
  const layout = [[1, 2], [2, 5], [3, 5], [4, 3]];
  for (const [type, count] of layout) {
    for (let i = 0; i < count; i++) {
      const quality = rand() * strength[t.id - 1];
      elements.push({
        id: pid++,
        web_name: surnames[(pid * 7 + t.id * 3) % surnames.length],
        team: t.id,
        element_type: type,
        quality,
        now_cost: Math.round(40 + quality * (type === 4 ? 90 : type === 3 ? 85 : type === 2 ? 30 : 20)),
      });
    }
  }
}
// Ownership skewed towards quality
const maxQ = Math.max(...elements.map((e) => e.quality));
for (const e of elements) {
  const q = e.quality / maxQ;
  e.selected_by_percent = (Math.pow(q, 3) * 55 + rand() * 3).toFixed(1);
}

// Live stats per GW
const live = {};
const GOAL = { 1: 10, 2: 6, 3: 5, 4: 4 };
for (let gw = 1; gw <= LAST_GW; gw++) {
  const cs = teams.map(() => rand() < 0.3);
  live[gw] = elements.map((e) => {
    const plays = rand() < (e.element_type === 1 ? (e.id % 2 ? 0.95 : 0.05) : 0.72 + e.quality * 0.2);
    const minutes = plays ? (rand() < 0.8 ? 90 : ri(20, 70)) : 0;
    const f = minutes / 90;
    const baseXg = { 1: 0, 2: 0.05, 3: 0.18, 4: 0.38 }[e.element_type] * e.quality * 1.6 * f;
    const baseXa = { 1: 0.01, 2: 0.06, 3: 0.17, 4: 0.12 }[e.element_type] * e.quality * 1.6 * f;
    const goals = minutes ? poisson(baseXg) : 0;
    const assists = minutes ? poisson(baseXa) : 0;
    let p = minutes >= 60 ? 2 : minutes > 0 ? 1 : 0;
    p += goals * GOAL[e.element_type] + assists * 3;
    if (minutes >= 60 && cs[e.team - 1]) p += e.element_type <= 2 ? 4 : e.element_type === 3 ? 1 : 0;
    if (goals + assists > 0) p += ri(0, 3);
    return {
      id: e.id,
      s: {
        minutes, goals_scored: goals, assists, total_points: p,
        expected_goals: baseXg.toFixed(2), expected_assists: baseXa.toFixed(2),
      },
    };
  });
}
const pts = (id, gw) => live[gw][id - 1].s.total_points;
const mins = (id, gw) => live[gw][id - 1].s.minutes;
for (const e of elements) e.total_points = Array.from({ length: LAST_GW }, (_, i) => pts(e.id, i + 1)).reduce((a, b) => a + b, 0);

// Most captained each week = highest owned attacker that week
const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1, name: `Gameweek ${i + 1}`, finished: i + 1 <= LAST_GW, is_current: i + 1 === LAST_GW,
  deadline_time: null, average_entry_score: 0, highest_score: 0, most_captained: null,
}));
const popular = [...elements].filter((e) => e.element_type >= 3).sort((a, b) => b.selected_by_percent - a.selected_by_percent);
for (let gw = 1; gw <= LAST_GW; gw++) events[gw - 1].most_captained = popular[gw % 3 === 0 ? 1 : 0].id;

// Fixtures for next 4 GWs
const fixtures = [];
for (let gw = LAST_GW + 1; gw <= LAST_GW + 4; gw++) {
  const order = [...teams].sort(() => rand() - 0.5);
  for (let i = 0; i < 20; i += 2) {
    const h = order[i].id, a = order[i + 1].id;
    const d = (t) => clamp(Math.round(2 + strength[t - 1] * 2.2), 2, 5);
    fixtures.push({ event: gw, team_h: h, team_a: a, team_h_difficulty: d(a), team_a_difficulty: d(h), finished: false });
  }
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Managers
const managerNames = [
  "Mo Ahmed", "Danny Cole", "Marcus Reid", "Jordan Hale", "Chris Lewis", "Ryan Walsh", "Liam Foster",
  "Kieran Moss", "Sam Okafor", "Jamie Knight", "Tom Barnes", "Lewis Grant", "Callum Drew", "Josh Ellis",
  "Aaron Price", "Nathan Quinn", "Ben Tate", "Harry Lowe", "Adam Wells", "Dean York",
];
const teamNamesF = [
  "Expected Toulouse", "Klopps and Robbers", "Ctrl Alt De Ligt", "Pope Francis", "Dukes of Hazard",
  "Murder on Zidane's Floor", "Lacazette Dreams", "Neville Wears Prada", "Tinchy Sneijder", "Cesc and the City",
  "Bayer Neverlusen", "Inter Yermum", "Real Sosobad", "Obi Wan Kenobi", "Fellaini Big Time", "Ings Can Only Get Better",
  "Thiago Tactics", "Pique Blinders", "Lord of the Ings", "Nkunku Fu Panda",
];

const SQUAD = { 1: 2, 2: 5, 3: 5, 4: 3 };
function buildSquad(skill, aiLike) {
  const squad = [];
  for (const [type, count] of Object.entries(SQUAD)) {
    const pool = elements.filter((e) => e.element_type === +type);
    while (squad.filter((s) => players(s).element_type === +type).length < count) {
      const sorted = [...pool].sort((a, b) =>
        (b.quality + (aiLike ? b.selected_by_percent / 30 : rand() * (1.4 - skill))) -
        (a.quality + (aiLike ? a.selected_by_percent / 30 : rand() * (1.4 - skill))));
      const p = sorted[ri(0, aiLike ? 4 : 14)];
      if (!squad.includes(p.id)) squad.push(p.id);
    }
  }
  return squad;
}
function players(id) { return elements[id - 1]; }

const entries = {};
const standings = [];
managerNames.forEach((name, i) => {
  const id = 1000000 + i * 7919;
  const skill = rand();
  const aiLike = i === 3 || i === 11;
  const rookie = aiLike || rand() < 0.15;
  let squad = buildSquad(skill, aiLike);
  const history = [];
  const transfers = [];
  const picks = {};
  let total = 0;
  const chips = [];
  const chipPlan = {};
  if (rand() < 0.5) chipPlan[ri(3, 8)] = "wildcard";
  if (rand() < 0.4) chipPlan[ri(2, 9)] = choice(["bboost", "3xc"]);

  for (let gw = 1; gw <= LAST_GW; gw++) {
    let cost = 0;
    if (gw > 1) {
      const n = chipPlan[gw] === "wildcard" ? 4 : rand() < 0.75 ? ri(1, aiLike ? 1 : 2) : 0;
      for (let k = 0; k < n; k++) {
        const outIdx = ri(0, 14);
        const out = squad[outIdx];
        const type = players(out).element_type;
        const pool = elements.filter((e) => e.element_type === type && !squad.includes(e.id));
        const sorted = [...pool].sort((a, b) => b.quality + (aiLike ? 0.5 : rand()) - (a.quality + (aiLike ? 0.5 : rand())));
        let inn = sorted[ri(0, aiLike ? 2 : 8)].id;
        // Sometimes buy back someone they sold earlier
        const exes = transfers.map((t) => t.element_out).filter((id) => players(id).element_type === type && !squad.includes(id));
        if (exes.length && rand() < 0.18) inn = choice(exes);
        squad[outIdx] = inn;
        transfers.push({ element_in: inn, element_out: out, event: gw, element_in_cost: players(inn).now_cost + ri(0, 3), element_out_cost: players(out).now_cost, time: "" });
      }
      if (n === 2 && !aiLike && rand() < 0.5 && chipPlan[gw] !== "wildcard") cost = 4;
    }
    const chip = chipPlan[gw] || null;
    if (chip) chips.push({ name: chip, event: gw, time: "" });

    // Order: GK by quality, outfield by quality (with noise for bad managers)
    const noisy = (id) => players(id).quality + rand() * (1.2 - skill) * (aiLike ? 0.1 : 1);
    const gks = squad.filter((s) => players(s).element_type === 1).sort((a, b) => noisy(b) - noisy(a));
    const out = squad.filter((s) => players(s).element_type !== 1).sort((a, b) => noisy(b) - noisy(a));
    const order = [gks[0], ...out.slice(0, 10), gks[1], ...out.slice(10)];
    const capId = [...order.slice(1, 11)].sort((a, b) => (aiLike ? players(b).selected_by_percent - players(a).selected_by_percent : noisy(b) - noisy(a)))[0];
    const viceId = order.slice(1, 11).find((x) => x !== capId);
    const pks = order.map((el, idx) => ({
      element: el, position: idx + 1, multiplier: idx < 11 ? 1 : 0,
      is_captain: el === capId, is_vice_captain: el === viceId,
    }));

    // Autosubs (simplified)
    const autos = [];
    if (chip !== "bboost") {
      const bench = order.slice(12);
      for (const starter of order.slice(1, 11)) {
        if (mins(starter, gw) === 0) {
          const sub = bench.find((b) => mins(b, gw) > 0 && !autos.some((a) => a.element_in === b));
          if (sub) autos.push({ element_in: sub, element_out: starter, entry: id, event: gw });
        }
      }
      if (mins(order[0], gw) === 0 && mins(order[11], gw) > 0) autos.push({ element_in: order[11], element_out: order[0], entry: id, event: gw });
    }
    const lineup = new Set(chip === "bboost" ? order : order.slice(0, 11));
    for (const a of autos) { lineup.delete(a.element_out); lineup.add(a.element_in); }
    const mult = chip === "3xc" ? 3 : 2;
    const eff = mins(capId, gw) > 0 ? capId : mins(viceId, gw) > 0 ? viceId : null;
    let gwPts = 0;
    for (const el of lineup) gwPts += pts(el, gw) * (el === eff ? mult : 1);
    const benchPts = chip === "bboost" ? 0 : order.filter((el) => !lineup.has(el)).reduce((a, el) => a + pts(el, gw), 0);
    total += gwPts - cost;
    history.push({
      event: gw, points: gwPts, total_points: total, rank: 0, overall_rank: 0,
      event_transfers: transfers.filter((t) => t.event === gw).length, event_transfers_cost: cost,
      points_on_bench: benchPts, bank: 0, value: 1000,
    });
    picks[gw] = { active_chip: chip, automatic_subs: autos, picks: pks, entry_history: history[history.length - 1] };
  }

  const past = rookie ? [] : Array.from({ length: ri(1, 7) }, (_, k) => {
    const yr = 2025 - k;
    return { season_name: `${yr}/${String(yr + 1).slice(2)}`, total_points: ri(1850, 2550), rank: Math.round(Math.pow(rand(), 1.3 - skill * 0.5) * 9000000) + ri(1000, 50000) };
  });

  entries[id] = { info: { id, started_event: 1, name: teamNamesF[i] }, history: { current: history, past, chips }, transfers: transfers.reverse(), picks };
  standings.push({ entry: id, entry_name: teamNamesF[i], player_name: name, rank: 0, total, event_total: history[history.length - 1].points });
});
standings.sort((a, b) => b.total - a.total).forEach((s, i) => (s.rank = i + 1));

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(new URL("../data/raw-demo.json", import.meta.url), JSON.stringify({
  demo: true,
  fetchedAt: new Date().toISOString(),
  leagueId: 566171,
  league: { id: 566171, name: "Demo League (dummy data)" },
  lastGw: LAST_GW,
  bootstrap: { events, teams, elements: elements.map(({ quality, ...e }) => e) },
  fixtures,
  standings,
  live,
  entries,
}));
console.log("Saved data/raw-demo.json");
