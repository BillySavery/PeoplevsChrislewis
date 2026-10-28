// Turns raw FPL data into the Fraud Detector scores.
// Usage: node scripts/score.mjs [path/to/raw.json]  ->  site/data.json
import { readFile, writeFile, mkdir } from "node:fs/promises";

const GOAL_PTS = { 1: 10, 2: 6, 3: 5, 4: 4 }; // GK, DEF, MID, FWD
const ASSIST_PTS = 3;
const POS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (arr) => {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2))) || 1;
};
const zscores = (arr) => {
  const m = mean(arr);
  const s = sd(arr);
  return arr.map((x) => (x - m) / s);
};
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function score(raw) {
  const { bootstrap, live, entries, standings, fixtures } = raw;
  const lastGw = raw.lastGw;
  const gws = Array.from({ length: lastGw }, (_, i) => i + 1);

  const players = new Map(bootstrap.elements.map((p) => [p.id, p]));
  const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const events = new Map(bootstrap.events.map((e) => [e.id, e]));
  const pname = (id) => players.get(id)?.web_name || `Player ${id}`;

  // Per gameweek player stats lookup
  const stats = {};
  for (const gw of gws) {
    stats[gw] = new Map((live[gw] || []).map((el) => [el.id, el.s]));
  }
  const pts = (id, gw) => stats[gw]?.get(id)?.total_points ?? 0;
  const mins = (id, gw) => stats[gw]?.get(id)?.minutes ?? 0;
  // Expected points: keep the real appearance, defensive and bonus points,
  // but swap actual goals and assists for expected goals and assists.
  const xpts = (id, gw) => {
    const s = stats[gw]?.get(id);
    if (!s) return 0;
    const gp = GOAL_PTS[players.get(id)?.element_type] || 4;
    const xg = parseFloat(s.expected_goals) || 0;
    const xa = parseFloat(s.expected_assists) || 0;
    return s.total_points - s.goals_scored * gp - s.assists * ASSIST_PTS + xg * gp + xa * ASSIST_PTS;
  };

  // Upcoming fixture difficulty per team
  const nextGws = new Set(Array.from({ length: raw.fixtureLookahead || 4 }, (_, i) => lastGw + 1 + i));
  const teamFdr = new Map();
  for (const f of fixtures) {
    if (!nextGws.has(f.event)) continue;
    const add = (team, d) => {
      const cur = teamFdr.get(team) || [];
      cur.push(d);
      teamFdr.set(team, cur);
    };
    add(f.team_h, f.team_h_difficulty);
    add(f.team_a, f.team_a_difficulty);
  }
  const fdrOf = (team) => {
    const list = teamFdr.get(team);
    return list && list.length ? mean(list) : 3;
  };

  // League position by gameweek (from running totals)
  const totalsByGw = {};
  for (const s of standings) {
    const hist = entries[s.entry]?.history?.current || [];
    for (const h of hist) {
      (totalsByGw[h.event] ||= []).push({ id: s.entry, total: h.total_points });
    }
  }
  const leaguePos = {};
  for (const [gw, list] of Object.entries(totalsByGw)) {
    list.sort((a, b) => b.total - a.total);
    list.forEach((row, i) => {
      (leaguePos[row.id] ||= {})[gw] = i + 1;
    });
  }

  const managers = standings.map((s) => {
    const e = entries[s.entry] || {};
    const hist = e.history?.current || [];
    const histByGw = new Map(hist.map((h) => [h.event, h]));
    const chips = e.history?.chips || [];
    const chipByGw = new Map(chips.map((c) => [c.event, c.name]));
    const past = e.history?.past || [];

    let captainLuck = 0;
    let autosubPts = 0;
    let overActual = 0;
    let overExpected = 0;
    let benchTotal = 0;
    let benchWorst = null;
    let luckiestMoment = null;
    let captainMatches = 0;
    let captainWeeks = 0;
    const captainLog = [];

    for (const gw of gws) {
      const pk = e.picks?.[gw];
      if (!pk || !pk.picks) continue;
      const chip = pk.active_chip || chipByGw.get(gw) || null;
      const bboost = chip === "bboost";

      // Effective lineup after automatic subs
      let lineup = new Set(pk.picks.filter((p) => bboost || p.position <= 11).map((p) => p.element));
      for (const sub of pk.automatic_subs || []) {
        lineup.delete(sub.element_out);
        lineup.add(sub.element_in);
        const gained = pts(sub.element_in, gw);
        autosubPts += gained;
      }
      const cap = pk.picks.find((p) => p.is_captain);
      const vice = pk.picks.find((p) => p.is_vice_captain);
      const mult = chip === "3xc" ? 3 : 2;
      let effCap = null;
      if (cap && mins(cap.element, gw) > 0) effCap = cap.element;
      else if (vice && mins(vice.element, gw) > 0) effCap = vice.element;

      if (effCap) {
        const luck = (pts(effCap, gw) - xpts(effCap, gw)) * (mult - 1);
        captainLuck += luck;
        captainLog.push({ gw, player: pname(effCap), pts: pts(effCap, gw) * mult, luck: round(luck) });
        if (!luckiestMoment || luck > luckiestMoment.luck) {
          luckiestMoment = { gw, player: pname(effCap), pts: pts(effCap, gw) * mult, xpts: round(xpts(effCap, gw) * mult), luck: round(luck) };
        }
      }
      if (cap) {
        captainWeeks++;
        if (events.get(gw)?.most_captained === cap.element) captainMatches++;
      }

      for (const id of lineup) {
        const m = id === effCap ? mult : 1;
        overActual += pts(id, gw) * m;
        overExpected += xpts(id, gw) * m;
      }

      if (!bboost) {
        const h = histByGw.get(gw);
        const benchPts = h?.points_on_bench ?? sum(pk.picks.filter((p) => !lineup.has(p.element)).map((p) => pts(p.element, gw)));
        benchTotal += benchPts;
        for (const p of pk.picks) {
          if (lineup.has(p.element)) continue;
          const bp = pts(p.element, gw);
          if (!benchWorst || bp > benchWorst.pts) benchWorst = { gw, player: pname(p.element), pts: bp };
        }
      }
    }

    // Transfers: compare incoming vs outgoing player from the transfer GW
    // until the incoming player was sold again (or now).
    const transfers = (e.transfers || []).slice().sort((a, b) => a.event - b.event);
    const tx = [];
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i];
      const chip = chipByGw.get(t.event);
      let end = lastGw;
      if (chip === "freehit") end = t.event;
      else {
        const soldLater = transfers.find((u, j) => j > i && u.element_out === t.element_in && u.event > t.event);
        if (soldLater) end = soldLater.event - 1;
      }
      let gain = 0;
      for (let gw = t.event; gw <= Math.min(end, lastGw); gw++) gain += pts(t.element_in, gw) - pts(t.element_out, gw);
      tx.push({ gw: t.event, in: pname(t.element_in), out: pname(t.element_out), gain, chip: chip || null });
    }
    const hits = sum(hist.map((h) => h.event_transfers_cost || 0));
    const grossGain = sum(tx.map((t) => t.gain));
    const netGain = grossGain - hits;
    const sortedTx = [...tx].sort((a, b) => a.gain - b.gain);

    // Latest squad for template and fixture checks
    const latestGw = Math.max(0, ...Object.keys(e.picks || {}).map(Number).filter((g) => e.picks[g]));
    const latest = e.picks?.[latestGw]?.picks || [];
    const squadIds = latest.map((p) => p.element);
    const ownership = mean(squadIds.map((id) => parseFloat(players.get(id)?.selected_by_percent) || 0));
    const startersFdr = mean(latest.filter((p) => p.position <= 11).map((p) => fdrOf(players.get(p.element)?.team)));

    // Form trend: last 3 GW vs season average
    const gwPoints = hist.map((h) => h.points - (h.event_transfers_cost || 0));
    const last3 = mean(gwPoints.slice(-3));
    const seasonAvg = mean(gwPoints);

    // Career from previous seasons
    const seasons = past.map((p) => ({ season: p.season_name, points: p.total_points, rank: p.rank }));
    const ranks = seasons.map((x) => x.rank).filter(Boolean);
    const best = ranks.length ? Math.min(...ranks) : null;
    const careerMedian = median(ranks);

    const posHistory = gws.map((gw) => leaguePos[s.entry]?.[gw] ?? null);

    return {
      id: s.entry,
      team: s.entry_name,
      manager: s.player_name,
      rank: s.rank,
      total: s.total,
      lastGwPoints: s.event_total,
      posHistory,
      gwPoints,
      chips: chips.map((c) => ({ name: c.name, gw: c.event })),
      luck: {
        captain: round(captainLuck),
        autosub: autosubPts,
        total: round(captainLuck + autosubPts),
        luckiestMoment,
        captainLog,
      },
      transfers: {
        count: tx.length,
        gross: grossGain,
        hits,
        net: netGain,
        regret: -netGain,
        best: sortedTx.length ? sortedTx[sortedTx.length - 1] : null,
        worst: sortedTx.length ? sortedTx[0] : null,
        hitRate: tx.length ? round((tx.filter((t) => t.gain > 0).length / tx.length) * 100, 0) : null,
      },
      bench: { total: benchTotal, worst: benchWorst },
      over: {
        actual: round(overActual),
        expected: round(overExpected),
        diff: round(overActual - overExpected),
      },
      squad: {
        ownership: round(ownership),
        fdr: round(startersFdr, 2),
        last3: round(last3),
        seasonAvg: round(seasonAvg),
      },
      career: { seasons, best, median: careerMedian, rookie: seasons.length === 0 },
      captainConformity: captainWeeks ? round((captainMatches / captainWeeks) * 100, 0) : 0,
    };
  });

  // ---- League relative models ----
  const n = managers.length;

  // Expected league finish from career median rank (rookies sit mid table)
  const veterans = managers.filter((m) => m.career.median !== null).sort((a, b) => a.career.median - b.career.median);
  const expectedPos = new Map();
  veterans.forEach((m, i) => {
    // Spread veterans across the league table
    expectedPos.set(m.id, 1 + (i * (n - 1)) / Math.max(1, veterans.length - 1));
  });
  for (const m of managers) if (!expectedPos.has(m.id)) expectedPos.set(m.id, (n + 1) / 2);

  const zOver = zscores(managers.map((m) => m.over.diff));
  const zLuck = zscores(managers.map((m) => m.luck.total));
  const zGap = zscores(managers.map((m) => expectedPos.get(m.id) - m.rank));
  const zFdr = zscores(managers.map((m) => m.squad.fdr));
  const zDrop = zscores(managers.map((m) => m.squad.seasonAvg - m.squad.last3));
  const zTop = zscores(managers.map((m) => n - m.rank));

  const zOwn = zscores(managers.map((m) => m.squad.ownership));
  const zCapConf = zscores(managers.map((m) => m.captainConformity));
  const zNoHits = zscores(managers.map((m) => -m.transfers.hits));
  const zTxRate = zscores(managers.map((m) => m.transfers.hitRate ?? 50));
  const zBench = zscores(managers.map((m) => -m.bench.total));

  managers.forEach((m, i) => {
    const parts = [
      { k: "over", w: 0.9, z: zOver[i], text: `Squad has scored ${Math.abs(m.over.diff)} points ${m.over.diff >= 0 ? "more" : "fewer"} than its underlying numbers say it should` },
      { k: "luck", w: 0.6, z: zLuck[i], text: `Captain and bench luck worth ${m.luck.total} points` },
      { k: "gap", w: 0.7, z: zGap[i], text: m.career.rookie ? `No track record whatsoever` : `Sitting ${ordinal(m.rank)} but their history says ${ordinal(Math.round(expectedPos.get(m.id)))}` },
      { k: "fdr", w: 0.5, z: zFdr[i], text: `Starting XI faces an average fixture difficulty of ${m.squad.fdr} over the next few weeks` },
      { k: "drop", w: 0.4, z: zDrop[i], text: `Averaging ${m.squad.last3} over the last 3 gameweeks against ${m.squad.seasonAvg} for the season` },
      { k: "top", w: 0.5, z: zTop[i], text: `Further to fall from ${ordinal(m.rank)}` },
    ];
    const logit = -1.1 + sum(parts.map((p) => p.w * p.z));
    m.fraud = {
      prob: clamp(Math.round(sigmoid(logit) * 100), 1, 99),
      reasons: parts.filter((p) => p.w * p.z > 0.15).sort((a, b) => b.w * b.z - a.w * a.z).slice(0, 3).map((p) => p.text),
      expectedPos: round(expectedPos.get(m.id), 0),
    };

    const ai = [
      { w: 0.9, z: zOwn[i], text: `Squad is ${m.squad.ownership}% owned on average. Template central` },
      { w: 0.8, z: zCapConf[i], text: `Captained the most popular pick ${m.captainConformity}% of the time` },
      { w: 0.6, z: zNoHits[i], text: m.transfers.hits === 0 ? `Has never taken a points hit. Suspiciously disciplined` : `Only ${m.transfers.hits} points spent on hits` },
      { w: 0.6, z: zTxRate[i], text: m.transfers.hitRate === null ? `No transfers at all. Either a bot or asleep` : `${m.transfers.hitRate}% of transfers came good` },
      { w: 0.4, z: zBench[i], text: `Only ${m.bench.total} points left on the bench. Machine like bench order` },
      { w: 0.5, z: m.career.rookie ? 1.2 : -0.2, text: `Brand new account, no previous seasons` },
    ];
    const aiLogit = -0.2 + sum(ai.map((p) => p.w * p.z));
    m.ai = {
      score: clamp(Math.round(sigmoid(aiLogit) * 100), 1, 99),
      tells: ai.filter((p) => p.w * p.z > 0.1).sort((a, b) => b.w * b.z - a.w * a.z).slice(0, 3).map((p) => p.text),
    };
  });

  for (const m of managers) m.verdict = verdict(m, managers);

  const by = (fn, dir = -1) => [...managers].sort((a, b) => dir * (fn(a) - fn(b)))[0];
  const awards = {
    luckiest: pick(by((m) => m.luck.total)),
    regret: pick(by((m) => m.transfers.regret)),
    bench: pick(by((m) => m.bench.total)),
    over: pick(by((m) => m.over.diff)),
    fraud: pick(by((m) => m.fraud.prob)),
    ai: pick(by((m) => m.ai.score)),
  };

  return {
    meta: {
      leagueId: raw.leagueId,
      leagueName: raw.league?.name || `League ${raw.leagueId}`,
      gw: lastGw,
      generatedAt: new Date().toISOString(),
      fetchedAt: raw.fetchedAt,
      demo: !!raw.demo,
      nextGws: [...nextGws],
    },
    awards,
    managers,
  };
}

function pick(m) {
  return m ? { id: m.id, team: m.team, manager: m.manager } : null;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function verdict(m, all) {
  const first = m.manager.split(" ")[0];
  const lines = [];
  if (m.fraud.prob >= 70) lines.push(`${first} is living on borrowed time. The numbers say this house of cards comes down soon.`);
  else if (m.fraud.prob >= 50) lines.push(`${first} is skating on thin ice. Not a fraud yet, but under active investigation.`);
  else if (m.fraud.prob <= 20 && m.rank <= Math.ceil(all.length / 3)) lines.push(`${first} is the real deal. Annoyingly, the underlying numbers back it up.`);
  else if (m.fraud.prob <= 20) lines.push(`${first} is bad, but honestly bad. The points table is telling the truth.`);
  else lines.push(`${first} is roughly where they deserve to be. Boring, but legitimate.`);

  if (m.luck.captain >= 15) lines.push(`Captaincy luck has carried them, with ${m.luck.luckiestMoment?.player} in GW${m.luck.luckiestMoment?.gw} doing the heavy lifting.`);
  else if (m.luck.autosub >= 30) lines.push(`Their bench keeps bailing them out: ${m.luck.autosub} points from automatic subs they never picked.`);
  if (m.transfers.net <= -20) lines.push(`Their transfers have cost them ${-m.transfers.net} points. They should have just left the team alone.`);
  else if (m.transfers.net >= 25) lines.push(`Transfers have gained ${m.transfers.net} points, which is either skill or a laptop doing the work.`);
  if (m.bench.worst && m.bench.worst.pts >= 10) lines.push(`Benched ${m.bench.worst.player} for ${m.bench.worst.pts} points in GW${m.bench.worst.gw}. Unforgivable.`);
  if (m.ai.score >= 70) lines.push(`AI suspicion is high. Someone check their browser history.`);
  return lines.slice(0, 3).join(" ");
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || new URL("../data/raw.json", import.meta.url).pathname;
  const raw = JSON.parse(await readFile(input));
  const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
  raw.fixtureLookahead = config.fixtureLookahead;
  const out = score(raw);
  out.meta.siteTitle = config.siteTitle;
  await mkdir(new URL("../site/", import.meta.url), { recursive: true });
  await writeFile(new URL("../site/data.json", import.meta.url), JSON.stringify(out));
  console.log(`Scored ${out.managers.length} managers up to GW${out.meta.gw} -> site/data.json`);
}
