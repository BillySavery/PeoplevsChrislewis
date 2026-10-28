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

  const leagueAvg = {};
  for (const [gw, list] of Object.entries(totalsByGw)) leagueAvg[gw] = 0;
  {
    const per = {};
    for (const s of standings) for (const h of entries[s.entry]?.history?.current || []) (per[h.event] ||= []).push(h.points);
    for (const [gw, list] of Object.entries(per)) leagueAvg[gw] = mean(list);
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
    const chipUses = [];

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

      // Chip outcomes
      if (chip === "3xc") {
        const extra = effCap ? pts(effCap, gw) : 0;
        chipUses.push({ name: chip, gw, value: extra, benchmark: 10, player: effCap ? pname(effCap) : null,
          text: `Triple Captain on ${effCap ? pname(effCap) : "a player who did not play"} returned ${extra} extra points` });
      } else if (chip === "bboost") {
        const benchIds = pk.picks.filter((p) => p.position > 11).map((p) => p.element);
        const val = sum(benchIds.map((id) => pts(id, gw)));
        chipUses.push({ name: chip, gw, value: val, benchmark: 12, text: `Bench Boost bench scored ${val} points` });
      } else if (chip === "freehit") {
        const h = histByGw.get(gw);
        const diff = round((h?.points ?? 0) - (leagueAvg[gw] ?? 0));
        chipUses.push({ name: chip, gw, value: diff, benchmark: 10, text: `Free Hit scored ${diff >= 0 ? diff + " above" : -diff + " below"} the league average` });
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

    // Wildcard: next three gameweeks against the league average
    for (const c of chips.filter((c) => c.name === "wildcard")) {
      const weeks = hist.filter((h) => h.event >= c.event && h.event < c.event + 3);
      if (!weeks.length) continue;
      const diff = round(sum(weeks.map((h) => h.points - (leagueAvg[h.event] ?? 0))));
      chipUses.push({ name: "wildcard", gw: c.event, value: diff, benchmark: 5 * weeks.length,
        text: `Wildcard team scored ${diff >= 0 ? diff + " above" : -diff + " below"} the league average over ${weeks.length} gameweeks` });
    }
    for (const c of chipUses) c.waste = round(Math.max(0, c.benchmark - c.value));
    const worstChip = [...chipUses].sort((a, b) => b.waste - a.waste)[0] || null;

    // Ex back syndrome: buying back a player they previously sold
    const exes = [];
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i];
      const sold = transfers.slice(0, i).reverse().find((u) => u.element_out === t.element_in && u.event < t.event);
      if (sold) {
        exes.push({ player: pname(t.element_in), soldGw: sold.event, backGw: t.event,
          soldFor: (sold.element_out_cost || 0) / 10, paid: (t.element_in_cost || 0) / 10 });
      }
    }

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
    const known = posHistory.map((p, i) => [i + 1, p]).filter(([, p]) => p != null);
    let peak = null;
    // Ignore the first two gameweeks: early positions are mostly noise
    const settled = known.filter(([gw]) => gw >= 3 || lastGw < 4);
    for (const [gw, p] of settled) if (!peak || p < peak.pos) peak = { pos: p, gw };
    const nowPos = known.length ? known[known.length - 1][1] : s.rank;

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
      coward: { matches: captainMatches, weeks: captainWeeks, pct: captainWeeks ? round((captainMatches / captainWeeks) * 100, 0) : 0 },
      chipWaste: { total: round(sum(chipUses.map((c) => c.waste))), uses: chipUses, worst: worstChip },
      exBack: { count: exes.length, list: exes },
      bottle: { peak: peak?.pos ?? s.rank, peakGw: peak?.gw ?? null, now: nowPos, drop: Math.max(0, nowPos - (peak?.pos ?? nowPos)) },
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

  forecast(managers, lastGw);
  for (const m of managers) m.verdict = verdict(m, managers);

  const by = (fn, dir = -1) => [...managers].sort((a, b) => dir * (fn(a) - fn(b)))[0];
  const awards = {
    luckiest: pick(by((m) => m.luck.total)),
    regret: pick(by((m) => m.transfers.regret)),
    bench: pick(by((m) => m.bench.total)),
    over: pick(by((m) => m.over.diff)),
    fraud: pick(by((m) => m.fraud.prob)),
    ai: pick(by((m) => m.ai.score)),
    exBack: pick(by((m) => m.exBack.count * 100 + sum(m.exBack.list.map((x) => x.paid - x.soldFor)))),
    bottle: pick(by((m) => m.bottle.drop * 100 - m.bottle.peak)),
    chipWaste: pick(by((m) => m.chipWaste.total)),
    coward: pick(by((m) => m.coward.pct * 100 + m.coward.matches)),
    forfeit: pick(by((m) => m.forfeit.last * 1000 - m.forfeit.projTotal)),
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

// ---------- Wooden spoon forecast ----------
// Simulates the rest of the season many times and counts how often each
// manager finishes last. Each manager's scoring rate is their season average,
// shrunk towards the league average, corrected for finishing luck, and
// nudged by their record from previous seasons.
function forecast(managers, lastGw, seasonLength = 38, sims = 20000) {
  const remaining = Math.max(0, seasonLength - lastGw);
  let seed = 38 + lastGw * 7919 + managers.length;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const normal = () => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const allWeeks = managers.flatMap((m) => m.gwPoints);
  const leagueMean = mean(allWeeks) || 50;
  const leagueSd = sd(allWeeks) || 15;

  const model = managers.map((m) => {
    const n = m.gwPoints.length || 1;
    const avg = mean(m.gwPoints) || leagueMean;
    const k = 6; // weeks of league average blended in
    let mu = (n * avg + k * leagueMean) / (n + k);
    mu -= 0.5 * (m.over.diff / n); // give back half the finishing luck
    if (m.career.median) mu += clamp((5.8 - Math.log10(m.career.median)) * 1.5, -3, 3);
    else mu -= 0.5;
    const own = sd(m.gwPoints);
    const weekSd = (n * own + k * leagueSd) / (n + k);
    return { m, mu, weekSd };
  });

  const lastCount = new Array(managers.length).fill(0);
  const bottom3 = new Array(managers.length).fill(0);
  const posSum = new Array(managers.length).fill(0);
  const totalSum = new Array(managers.length).fill(0);
  const finals = new Array(managers.length);
  const skillSd = 3; // uncertainty about each manager's true weekly rate

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < model.length; i++) {
      const { m, mu, weekSd } = model[i];
      const rate = mu + normal() * skillSd;
      finals[i] = m.total + remaining * rate + Math.sqrt(remaining) * weekSd * normal();
      totalSum[i] += finals[i];
    }
    const order = finals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    order.forEach(([, i], pos) => {
      posSum[i] += pos + 1;
      if (pos === order.length - 1) lastCount[i]++;
      if (pos >= order.length - 3) bottom3[i]++;
    });
  }

  model.forEach(({ m, mu }, i) => {
    m.forfeit = {
      last: round((lastCount[i] / sims) * 100, 1),
      bottom3: round((bottom3[i] / sims) * 100, 0),
      projTotal: Math.round(totalSum[i] / sims),
      projPos: round(posSum[i] / sims, 1),
      rate: round(mu),
      remaining,
    };
  });
  const sortedProj = [...managers].sort((a, b) => a.forfeit.projTotal - b.forfeit.projTotal);
  const safety = sortedProj[1]?.forfeit.projTotal ?? 0;
  for (const m of managers) m.forfeit.gapToSafety = m.forfeit.projTotal - safety;
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
  if (m.fraud.prob >= 70) lines.push(`${first}'s league position is not supported by the underlying data. The model expects a significant fall over the coming gameweeks.`);
  else if (m.fraud.prob >= 50) lines.push(`${first} is showing several warning signs. The case remains open and will be reviewed after the next gameweek.`);
  else if (m.fraud.prob <= 20 && m.rank <= Math.ceil(all.length / 3)) lines.push(`${first}'s results are consistent with genuine skill. No action recommended at this time.`);
  else if (m.fraud.prob <= 20) lines.push(`${first}'s results are poor, but the data indicates they are honestly poor.`);
  else lines.push(`${first} is performing broadly in line with expectations. No significant anomalies detected.`);

  if (m.forfeit.last >= 25) lines.push(`The forecast model makes them a ${m.forfeit.last}% chance to finish last and face the forfeit.`);
  if (m.luck.captain >= 15) lines.push(`A large share of their points came from captain returns well above expected, most notably ${m.luck.luckiestMoment?.player} in GW${m.luck.luckiestMoment?.gw}.`);
  else if (m.luck.autosub >= 30) lines.push(`Automatic substitutions have contributed ${m.luck.autosub} points, unusually high for this league.`);
  if (m.exBack.count) lines.push(`Repurchased ${m.exBack.list[0].player} after previously selling him, a pattern flagged as Ex back syndrome.`);
  if (m.bottle.drop >= 5) lines.push(`Has fallen from ${ordinal(m.bottle.peak)} in GW${m.bottle.peakGw} to ${ordinal(m.bottle.now)}.`);
  if (m.transfers.net <= -20) lines.push(`Transfer activity has cost ${-m.transfers.net} points compared with simply holding.`);
  else if (m.transfers.net >= 25) lines.push(`Transfer success is well above the rate we see in typical human managed teams.`);
  if (m.chipWaste.worst && m.chipWaste.worst.waste >= 8) lines.push(`${m.chipWaste.worst.text} in GW${m.chipWaste.worst.gw}, a poor return on a chip.`);
  if (m.bench.worst && m.bench.worst.pts >= 10) lines.push(`Left ${m.bench.worst.player} on the bench for ${m.bench.worst.pts} points in GW${m.bench.worst.gw}.`);
  if (m.ai.score >= 70) lines.push(`AI usage indicators are elevated and this account has been flagged for further review.`);
  return lines.slice(0, 3).join(" ");
}

// ---------- The courtroom ----------
const OFFENCES = [
  { key: "fraud", title: "Fraudulent occupation of a league position", v: (m) => m.fraud.prob,
    ev: (m) => `Fraud probability of ${m.fraud.prob}%. ${m.fraud.reasons[0] || ""}`,
    sentence: "Placed on probation. The court expects regression to the mean and will be monitoring every gameweek." },
  { key: "luck", title: "Obtaining points by fortune", v: (m) => m.luck.total,
    ev: (m) => `${m.luck.total} points gained through captain returns above expected and automatic substitutions${m.luck.luckiestMoment ? `, including ${m.luck.luckiestMoment.player} in GW${m.luck.luckiestMoment.gw}` : ""}.`,
    sentence: "Placed on probation. The court expects regression to the mean and will be monitoring every gameweek." },
  { key: "regret", title: "Reckless transferring", v: (m) => m.transfers.regret,
    ev: (m) => `Transfers have cost ${m.transfers.regret} points against holding${m.transfers.worst ? `. Worst offence: ${m.transfers.worst.out} out for ${m.transfers.worst.in} in GW${m.transfers.worst.gw}` : ""}.`,
    sentence: (m, gw) => `Banned from making transfers without written approval from two other managers until GW${gw + 3}.` },
  { key: "bench", title: "Wilful neglect of points", v: (m) => m.bench.total,
    ev: (m) => `${m.bench.total} points left on the bench${m.bench.worst ? `, including ${m.bench.worst.player} for ${m.bench.worst.pts} in GW${m.bench.worst.gw}` : ""}.`,
    sentence: "Ordered to post his starting XI in the group chat before every deadline for four gameweeks so the court can inspect his bench." },
  { key: "over", title: "Living beyond underlying means", v: (m) => m.over.diff,
    ev: (m) => `Starting XI has scored ${m.over.actual} points against ${m.over.expected} expected.`,
    sentence: "Placed on probation. The court expects regression to the mean and will be monitoring every gameweek." },
  { key: "ai", title: "Suspected use of an unlicensed assistant", v: (m) => m.ai.score,
    ev: (m) => `AI detection confidence of ${m.ai.score}%. ${m.ai.tells[0] || ""}`,
    sentence: "Required to make every decision with pen and paper, unassisted, for the next three gameweeks." },
  { key: "exBack", title: "Reconciliation with a previously sold player", v: (m) => m.exBack.count, min: 1,
    ev: (m) => m.exBack.list.map((x) => `Sold ${x.player} in GW${x.soldGw}, bought him back in GW${x.backGw}`).join(". ") + ".",
    sentence: "Restraining order: may not transfer in any player he has previously sold for the rest of the season." },
  { key: "bottle", title: "Bottling a winning position", v: (m) => m.bottle.drop, min: 3,
    ev: (m) => `Peaked at ${ordinal(m.bottle.peak)} in GW${m.bottle.peakGw}, now ${ordinal(m.bottle.now)}.`,
    sentence: "Placed on bottle watch. Any further drop in position triggers an automatic review." },
  { key: "chipWaste", title: "Criminal waste of a chip", v: (m) => m.chipWaste.total, min: 5,
    ev: (m) => m.chipWaste.worst ? `${m.chipWaste.worst.text} in GW${m.chipWaste.worst.gw}.` : "",
    sentence: "Remaining chips to be held in trust by the league until further notice." },
  { key: "coward", title: "Captaincy cowardice", v: (m) => m.coward.pct,
    ev: (m) => `Copied the most popular captain in ${m.coward.matches} of ${m.coward.weeks} gameweeks.`,
    sentence: "Must captain a player owned by fewer than 10% of managers in the next gameweek." },
];

const DEFENCES = [
  "The defence maintains the defendant was the victim of rotation, injuries and a referee with a personal grudge.",
  "The defence argues that expected goals are not real and should not be admissible in this court.",
  "The defence submits that the defendant was busy, had a lot on, and set his team on the bus.",
  "The defence claims the defendant was playing the long game and the results will come.",
];

function findDefendant(managers, name) {
  if (!name) return null;
  const want = name.toLowerCase().trim();
  const parts = want.split(/\s+/);
  const last = parts[parts.length - 1];
  return (
    managers.find((m) => m.manager.toLowerCase().trim() === want) ||
    managers.find((m) => m.manager.toLowerCase().includes(want)) ||
    managers.find((m) => {
      const n = m.manager.toLowerCase().split(/\s+/);
      return n[0].startsWith(parts[0]) && n[n.length - 1] === last;
    }) ||
    managers.find((m) => m.manager.toLowerCase().split(/\s+/).includes(last)) ||
    null
  );
}

export function buildCourt(managers, name, gw) {
  const m = findDefendant(managers, name);
  if (!m) return { found: false, name };
  const n = managers.length;
  const ranked = OFFENCES.map((o) => {
    const sorted = [...managers].sort((a, b) => o.v(b) - o.v(a));
    const rank = sorted.findIndex((x) => x.id === m.id) + 1;
    return { o, rank, value: o.v(m) };
  }).filter((r) => r.value >= (r.o.min ?? -Infinity));
  ranked.sort((a, b) => a.rank - b.rank);
  let counts = ranked.filter((r) => r.rank <= Math.ceil(n / 3));
  if (counts.length < 2) counts = ranked.slice(0, 2);
  counts = counts.slice(0, 6);

  const surname = m.manager.split(" ").slice(-1)[0];
  const guilty = counts.filter((c) => c.rank <= Math.ceil(n / 4)).length;
  const votes = clamp(Math.round(7 + guilty * 1.2 + m.fraud.prob / 30), 8, 12);
  const outcome = votes >= 10 ? "Guilty" : votes >= 7 ? "Guilty by majority verdict" : "Hung jury";
  const worst = counts[0];
  const sentence = typeof worst.o.sentence === "function" ? worst.o.sentence(m, gw) : worst.o.sentence;

  const prosecution = `The prosecution will show that between GW1 and GW${gw} the defendant, ${m.manager}, manager of ${m.team}, ` +
    `committed ${counts.length} offences against this league. He currently sits ${ordinal(m.rank)} on ${m.total} points. ` +
    (m.fraud.prob >= 40
      ? `The detection model rates the likelihood of his position collapsing at ${m.fraud.prob}%.`
      : `The court will hear evidence on each count in turn.`);

  const record = m.career.seasons.length
    ? m.career.seasons.map((x) => ({ season: x.season, rank: x.rank, points: x.points }))
    : [];

  return {
    found: true,
    id: m.id,
    name: m.manager,
    surname,
    team: m.team,
    rank: m.rank,
    total: m.total,
    gw,
    caseNo: `FPL/${gw}/${String(m.id).slice(-5)}`,
    counts: counts.map((c, i) => ({
      no: i + 1,
      title: c.o.title,
      key: c.o.key,
      rankInLeague: c.rank,
      evidence: c.o.ev(m).trim().replace(/\s+\./g, ".").replace(/([^.])$/, "$1."),
      finding: c.rank <= Math.ceil(n / 4) ? "Guilty" : "Proven on the balance of probabilities",
    })),
    prosecution,
    defence: DEFENCES[m.id % DEFENCES.length],
    jury: { guilty: votes, total: 12 },
    outcome,
    sentence,
    summing: outcome === "Hung jury"
      ? `The jury could not reach a verdict. Mr ${surname} is released pending further evidence, which the court fully expects to arrive.`
      : `Having considered the evidence, the jury finds Mr ${surname} ${outcome.toLowerCase()}. The court notes the defendant showed no remorse.`,
    record,
    nextHearing: gw + 1,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || new URL("../data/raw.json", import.meta.url).pathname;
  const raw = JSON.parse(await readFile(input));
  const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
  raw.fixtureLookahead = config.fixtureLookahead;
  const out = score(raw);
  out.meta.siteTitle = config.siteTitle;
  out.court = buildCourt(out.managers, config.defendant, out.meta.gw);
  await mkdir(new URL("../site/", import.meta.url), { recursive: true });
  await writeFile(new URL("../site/data.json", import.meta.url), JSON.stringify(out));
  console.log(`Scored ${out.managers.length} managers up to GW${out.meta.gw} -> site/data.json`);
  if (process.env.GITHUB_ACTIONS) {
    const c = out.court;
    console.log(c.found
      ? `::notice title=Courtroom::Defendant matched to ${c.name} (${c.team}). Verdict: ${c.outcome}, ${c.counts.length} counts.`
      : `::warning title=Courtroom::No manager matching "${c.name}" found in the league.`);
    const fav = [...out.managers].sort((a, b) => b.forfeit.last - a.forfeit.last).slice(0, 3);
    console.log(`::notice title=Forfeit::${fav.map((m) => `${m.manager} ${m.forfeit.last}%`).join(", ")}`);
    console.log(`::notice title=League::${out.meta.leagueName}, ${out.managers.length} managers, GW${out.meta.gw}.`);
  }
}
