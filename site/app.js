const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const rankFmt = (r) => (r == null ? "n/a" : r >= 1e6 ? `${(r / 1e6).toFixed(2)}m` : r >= 1e3 ? `${Math.round(r / 1e3)}k` : r);
const CHIPS = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain", manager: "Assistant Manager" };

const INDEXES = [
  {
    key: "fraud", label: "Fraud probability", unit: "%",
    desc: "Probability this manager falls significantly down the table over the next four gameweeks. The model weighs overperformance against expected goals, luck, upcoming fixture difficulty, recent form and where their record from previous seasons says they should be.",
    value: (m) => m.fraud.prob, show: (m) => `${m.fraud.prob}%`,
    detail: (m) => m.fraud.reasons[0] || "No significant risk factors detected",
  },
  {
    key: "luck", label: "Lucky bastard index", unit: "pts",
    desc: "Points gained from captains outscoring their expected goals and assists, plus points rescued by automatic substitutions. Measures how much of a score came from fortune rather than decisions.",
    value: (m) => m.luck.total, show: (m) => m.luck.total,
    detail: (m) => m.luck.luckiestMoment ? `${m.luck.luckiestMoment.player} captain in GW${m.luck.luckiestMoment.gw}: ${m.luck.luckiestMoment.pts} pts from ${m.luck.luckiestMoment.xpts} expected` : "No captain data",
  },
  {
    key: "regret", label: "Transfer regret", unit: "pts", diverge: true,
    desc: "Points lost by transferring compared with keeping the player sold, tracked from the week of the move until the new player was sold again. Points hits included. A positive score means they would have been better off doing nothing.",
    value: (m) => m.transfers.regret, show: (m) => fmt(m.transfers.regret),
    detail: (m) => m.transfers.worst ? `Worst: ${m.transfers.worst.out} out, ${m.transfers.worst.in} in (GW${m.transfers.worst.gw}, ${fmt(m.transfers.worst.gain)})` : "No transfers made",
  },
  {
    key: "bench", label: "Benchwarmer crimes", unit: "pts",
    desc: "Total points left on the bench this season, excluding Bench Boost weeks.",
    value: (m) => m.bench.total, show: (m) => m.bench.total,
    detail: (m) => m.bench.worst ? `Benched ${m.bench.worst.player} for ${m.bench.worst.pts} in GW${m.bench.worst.gw}` : "Clean record",
  },
  {
    key: "over", label: "Overachiever alert", unit: "pts", diverge: true,
    desc: "Actual points from the starting XI minus what the same players would have scored if goals and assists matched expected goals and assists. Large positive numbers indicate finishing luck, which historically does not last.",
    value: (m) => m.over.diff, show: (m) => fmt(m.over.diff),
    detail: (m) => `${m.over.actual} actual from ${m.over.expected} expected`,
  },
  {
    key: "exBack", label: "Ex back syndrome", unit: "",
    desc: "Players bought back after previously being sold. Repeat offenders and anyone paying more the second time round rank highest.",
    value: (m) => m.exBack.count * 100 + m.exBack.list.reduce((a, x) => a + x.paid - x.soldFor, 0), show: (m) => m.exBack.count,
    detail: (m) => m.exBack.list.length ? m.exBack.list.map((x) => `${x.player} (sold GW${x.soldGw}, back GW${x.backGw})`).join(", ") : "No reconciliations on record",
  },
  {
    key: "bottle", label: "Bottle job index", unit: "",
    desc: "Places dropped from their highest league position since gameweek 3. Early season positions are ignored as noise.",
    value: (m) => m.bottle.drop * 100 - m.bottle.peak, show: (m) => m.bottle.drop,
    detail: (m) => m.bottle.peakGw ? `Peaked ${ordinal(m.bottle.peak)} in GW${m.bottle.peakGw}, now ${ordinal(m.bottle.now)}` : "Not enough gameweeks yet",
  },
  {
    key: "chipWaste", label: "Chip waster", unit: "pts",
    desc: "Points short of a reasonable return on each chip played. Benchmarks: Triple Captain 10 extra points, Bench Boost 12 bench points, Free Hit 10 above the league average, Wildcard 5 a week above the league average over the following three gameweeks.",
    value: (m) => m.chipWaste.total, show: (m) => m.chipWaste.total,
    detail: (m) => m.chipWaste.worst ? `${m.chipWaste.worst.text} (GW${m.chipWaste.worst.gw})` : "No chips played yet",
  },
  {
    key: "coward", label: "Captain coward", unit: "%",
    desc: "Share of gameweeks they captained the most popular captain in the whole game that week instead of backing their own judgement.",
    value: (m) => m.coward.pct * 100 + m.coward.matches, show: (m) => `${m.coward.pct}%`,
    detail: (m) => `Followed the crowd in ${m.coward.matches} of ${m.coward.weeks} gameweeks`,
  },
  {
    key: "ai", label: "AI suspicion", unit: "%",
    desc: "Likelihood this team is being picked with help from an AI tool. Our model checks every decision against the patterns AI built squads leave behind: template ownership, always copying the most popular captain, never taking hits, transfers that land too often, and brand new accounts with no history.",
    value: (m) => m.ai.score, show: (m) => `${m.ai.score}%`,
    detail: (m) => m.ai.tells[0] || "Seems to be thinking for themselves",
  },
];

const CHARGES = [
  { key: "forfeit", text: "Favourite for the forfeit", val: (m) => `${m.forfeit.last}%` },
  { key: "fraud", text: "Most likely to collapse", val: (m) => `${m.fraud.prob}%` },
  { key: "luckiest", idx: "luck", text: "Luckiest bastard", val: (m) => `${m.luck.total} pts` },
  { key: "regret", text: "Most transfer regret", val: (m) => `${fmt(m.transfers.regret)} pts` },
  { key: "bench", text: "Worst benchwarmer", val: (m) => `${m.bench.total} pts` },
  { key: "over", text: "Biggest overachiever", val: (m) => `${fmt(m.over.diff)} pts` },
  { key: "ai", text: "Most likely using AI", val: (m) => `${m.ai.score}%` },
  { key: "exBack", text: "Ex back syndrome", val: (m) => `${m.exBack.count} buy back${m.exBack.count === 1 ? "" : "s"}` },
  { key: "bottle", text: "Biggest bottle job", val: (m) => `${m.bottle.drop} places` },
  { key: "chipWaste", text: "Chip waster", val: (m) => `${m.chipWaste.total} pts` },
  { key: "coward", text: "Captain coward", val: (m) => `${m.coward.pct}%` },
];

let data;
let current = "fraud";

async function init() {
  const res = await fetch(`data.json?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    $("#sub").textContent = "No data yet. Run the update job in GitHub Actions to load your league.";
    return;
  }
  data = await res.json();
  const { meta } = data;
  document.title = `${meta.siteTitle || "FPL Fraud Detector"}: ${meta.leagueName}`;
  $("#sub").textContent = `Automated integrity analysis for ${meta.leagueName}. Data current to gameweek ${meta.gw}.`;
  if (data.court?.found) {
    const a = $("#court-link");
    a.hidden = false;
    a.querySelector("span").textContent = `Now in session: The People v ${data.court.name}`;
  }
  $("#demo").hidden = !meta.demo;
  $("#foot").textContent = `League ${meta.leagueId}. Detection model 2.4. Last analysed ${new Date(meta.generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}. Not affiliated with the Premier League.`;
  renderLineup();
  renderCharges();
  renderForfeit();
  renderTabs();
  renderTable();
  renderMethod();
  const hash = location.hash.match(/^#m(\d+)$/);
  if (hash) openDossier(+hash[1]);
}

function figureSvg(m) {
  const head = m?.photo
    ? `<img class="head photo" src="${esc(m.photo)}" alt="">`
    : `<span class="head"></span>`;
  return `${head}<span class="torso"><span class="tag"></span></span>`;
}
const avatar = (m) => (m.photo ? `<img class="avatar" src="${esc(m.photo)}" alt="">` : "");

function renderLineup() {
  const top = [...data.managers].sort((a, b) => b.fraud.prob - a.fraud.prob).slice(0, 5);
  const heights = $("#heights");
  heights.innerHTML = [0, 25, 50, 75, 100].map((v) => `<span class="scale" style="bottom:${v}%">${v}</span>`).join("");
  $("#suspects").innerHTML = top.map((m) => {
    const h = Math.max(18, m.fraud.prob);
    return `<button class="suspect" data-id="${m.id}" aria-label="${esc(m.team)}, ${esc(m.manager)}, ${m.fraud.prob}% fraud probability">
      <div class="figure" style="height:calc(${h}% - 30px)">${figureSvg(m)}</div>
      <div class="plate ${m.fraud.prob >= 70 ? "hot" : ""}">${m.fraud.prob}%</div>
    </button>`;
  }).join("");
  $("#names").innerHTML = top.map((m) => `<div><strong>${esc(m.team)}</strong><span>${esc(m.manager)}, ${ordinal(m.rank)}</span></div>`).join("");
  $("#suspects").addEventListener("click", (e) => {
    const b = e.target.closest(".suspect");
    if (b) openDossier(+b.dataset.id);
  });
}

function renderCharges() {
  const byId = new Map(data.managers.map((m) => [m.id, m]));
  $("#charges").innerHTML = CHARGES.map((c) => {
    const a = data.awards[c.key];
    const m = a && byId.get(a.id);
    if (!m) return "";
    return `<li><button data-id="${m.id}"><span class="what">${c.text}</span><span class="who">${esc(m.team)}<br><span class="person" style="font-weight:400;color:var(--muted);font-size:15px">${esc(m.manager)}</span></span><span class="val">${c.val(m)}</span></button></li>`;
  }).join("");
  $("#charges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) openDossier(+b.dataset.id);
  });
}

function renderForfeit() {
  const rows = [...data.managers].sort((a, b) => b.forfeit.last - a.forfeit.last || a.forfeit.projTotal - b.forfeit.projTotal);
  const fav = rows[0];
  const rem = fav.forfeit.remaining;
  $("#favourite").innerHTML = `
    <button data-id="${fav.id}">
      ${fav.photo ? `<img class="fav-photo" src="${esc(fav.photo)}" alt="">` : ""}
      <span class="fav-label">Current favourite</span>
      <span class="fav-name">${esc(fav.manager)}</span>
      <span class="fav-team">${esc(fav.team)}, ${ordinal(fav.rank)} on ${fav.total} points</span>
      <span class="fav-odds">${fav.forfeit.last}%<small>chance of finishing last</small></span>
    </button>`;
  const max = Math.max(1, rows[0].forfeit.last);
  $("#forfeit-table tbody").innerHTML = rows.map((m, i) => `
    <tr data-id="${m.id}">
      <td class="pos">${i + 1}</td>
      <td class="mgr"><button>${avatar(m)}<span class="team">${esc(m.team)}</span><span class="person">${esc(m.manager)}, ${ordinal(m.rank)} in league</span></button></td>
      <td class="num">${m.forfeit.last < 0.5 && m.forfeit.last > 0 ? "<1" : Math.round(m.forfeit.last)}%</td>
      <td class="bar-col"><div class="bar hot"><i style="left:0;width:${(m.forfeit.last / max) * 100}%"></i></div></td>
      <td class="num b3-col">${m.forfeit.bottom3}%</td>
      <td class="num proj-col">${m.forfeit.projTotal}</td>
    </tr>`).join("");
  $("#forfeit-note").textContent = rem > 0
    ? `Based on 20,000 simulations of the remaining ${rem} gameweeks. Each manager's scoring rate is their season average adjusted for finishing luck against expected goals and their record from previous seasons. Updated after every gameweek.`
    : "The season is over. The result is final.";
  const open = (e) => {
    const t = e.target.closest("[data-id]");
    if (t) openDossier(+t.dataset.id);
  };
  $("#favourite").onclick = open;
  $("#forfeit-table tbody").onclick = open;
}

function renderTabs() {
  $("#tabs").innerHTML = INDEXES.map((ix) =>
    `<button role="tab" id="tab-${ix.key}" aria-controls="table" aria-selected="${ix.key === current}" data-key="${ix.key}">${ix.label}</button>`
  ).join("");
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    current = b.dataset.key;
    for (const t of $("#tabs").children) t.setAttribute("aria-selected", t.dataset.key === current);
    renderTable();
  });
}

function renderTable() {
  const ix = INDEXES.find((i) => i.key === current);
  $("#tab-desc").textContent = ix.desc;
  $("#th-value").textContent = ix.unit === "%" ? "Score" : "Points";
  $("#table").setAttribute("aria-labelledby", `tab-${ix.key}`);
  const rows = [...data.managers].sort((a, b) => ix.value(b) - ix.value(a));
  const maxAbs = Math.max(1, ...rows.map((m) => Math.abs(ix.value(m))));
  $("#table tbody").innerHTML = rows.map((m, i) => {
    const v = ix.value(m);
    let bar;
    if (ix.diverge) {
      const w = (Math.abs(v) / maxAbs) * 50;
      bar = `<div class="bar diverge"><i class="${v < 0 ? "neg" : ""}" style="${v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></i></div>`;
    } else {
      const max = ix.unit === "%" ? 100 : maxAbs;
      bar = `<div class="bar"><i style="left:0;width:${Math.max(0, (v / max) * 100)}%"></i></div>`;
    }
    return `<tr data-id="${m.id}">
      <td class="pos">${i + 1}</td>
      <td class="mgr"><button>${avatar(m)}<span class="team">${esc(m.team)}</span><span class="person">${esc(m.manager)}, ${ordinal(m.rank)} in league</span></button></td>
      <td class="num">${ix.show(m)}</td>
      <td class="bar-col">${bar}</td>
      <td class="detail-col">${esc(ix.detail(m))}</td>
    </tr>`;
  }).join("");
  $("#table tbody").onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDossier(+tr.dataset.id);
  };
}

function renderMethod() {
  $("#method").innerHTML = INDEXES.map((ix) => `<div><dt>${ix.label}</dt><dd>${ix.desc}</dd></div>`).join("");
}

function spark(m) {
  const pts = m.posHistory.map((p, i) => [i, p]).filter(([, p]) => p != null);
  if (pts.length < 2) return "";
  const n = data.managers.length;
  const W = 600, H = 90, pad = 10;
  const x = (i) => pad + (i / (m.posHistory.length - 1)) * (W - pad * 2);
  const y = (p) => pad + ((p - 1) / Math.max(1, n - 1)) * (H - pad * 2);
  const d = pts.map(([i, p], k) => `${k ? "L" : "M"}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="League position by gameweek, from ${ordinal(pts[0][1])} to ${ordinal(last[1])}">
    <line x1="${pad}" x2="${W - pad}" y1="${y(1)}" y2="${y(1)}" stroke="#d5d9e0" stroke-dasharray="4 4"/>
    <line x1="${pad}" x2="${W - pad}" y1="${y(n)}" y2="${y(n)}" stroke="#d5d9e0" stroke-dasharray="4 4"/>
    <path d="${d}" fill="none" stroke="#1f2a3c" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last[0])}" cy="${y(last[1])}" r="4" fill="#d7263d"/>
  </svg>`;
}

function openDossier(id) {
  const m = data.managers.find((x) => x.id === id);
  if (!m) return;
  const dlg = $("#dossier");
  const hot = m.fraud.prob >= 60;
  const stamp = m.fraud.prob >= 70 ? "Fraud confirmed" : m.fraud.prob >= 50 ? "Under investigation" : m.fraud.prob >= 25 ? "Person of interest" : "Cleared";
  const seasons = m.career.seasons;
  const txRows = [m.transfers.best, m.transfers.worst].filter(Boolean);
  const caps = [...(m.luck.captainLog || [])].sort((a, b) => a.gw - b.gw);

  $("#dossier-body").innerHTML = `
    <div class="dossier-head${m.photo ? " has-mug" : ""}">
      ${m.photo ? `<figure class="mug"><img src="${esc(m.photo)}" alt="Mugshot of ${esc(m.manager)}"><figcaption>${m.id}</figcaption></figure>` : ""}
      <h3 id="dossier-title">${esc(m.team)}</h3>
      <p>${esc(m.manager)}. ${ordinal(m.rank)} in the league on ${m.total} points. Case number ${m.id}.</p>
      <span class="stamp ${hot ? "hot" : ""}">${stamp}</span>
      <button class="close" aria-label="Close dossier">×</button>
    </div>
    <div class="dossier-section">
      <h4>The verdict</h4>
      <p class="verdict">${esc(m.verdict)}</p>
    </div>
    <div class="dossier-section">
      <dl class="stats">
        <div><dt>Fraud probability</dt><dd>${m.fraud.prob}%<small>History says ${ordinal(m.fraud.expectedPos)}</small></dd></div>
        <div><dt>Lucky bastard index</dt><dd>${m.luck.total}<small>${m.luck.captain} captain, ${m.luck.autosub} from subs</small></dd></div>
        <div><dt>Transfer regret</dt><dd>${fmt(m.transfers.regret)}<small>${m.transfers.count} transfers, ${m.transfers.hits} pts in hits</small></dd></div>
        <div><dt>Benchwarmer crimes</dt><dd>${m.bench.total}<small>points left on the bench</small></dd></div>
        <div><dt>Overachiever alert</dt><dd>${fmt(m.over.diff)}<small>${m.over.actual} actual, ${m.over.expected} expected</small></dd></div>
        <div><dt>Forfeit odds</dt><dd>${m.forfeit.last}%<small>chance of finishing last, projected ${m.forfeit.projTotal} pts</small></dd></div>
        <div><dt>Ex back syndrome</dt><dd>${m.exBack.count}<small>players bought back</small></dd></div>
        <div><dt>Bottle job index</dt><dd>${m.bottle.drop}<small>${m.bottle.peakGw ? `peaked ${ordinal(m.bottle.peak)} in GW${m.bottle.peakGw}` : "places dropped"}</small></dd></div>
        <div><dt>Chip waster</dt><dd>${m.chipWaste.total}<small>points short on chips</small></dd></div>
        <div><dt>Captain coward</dt><dd>${m.coward.pct}%<small>${m.coward.matches} of ${m.coward.weeks} weeks with the crowd</small></dd></div>
        <div><dt>AI suspicion</dt><dd>${m.ai.score}%<small>detection confidence</small></dd></div>
      </dl>
    </div>
    ${m.fraud.reasons.length ? `<div class="dossier-section"><h4>Why they might collapse</h4><ul class="reasons">${m.fraud.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
    <div class="dossier-section">
      <h4>League position by gameweek</h4>
      ${spark(m)}
      <p class="note">Top of the dotted lines is 1st, bottom is ${ordinal(data.managers.length)}.</p>
    </div>
    <div class="dossier-section">
      <h4>Rap sheet from previous seasons</h4>
      ${seasons.length ? `<table class="mini-table"><thead><tr><th>Season</th><th class="num">Points</th><th class="num">Overall rank</th></tr></thead><tbody>
        ${seasons.map((s) => `<tr><td>${esc(s.season)}</td><td class="num">${s.points}</td><td class="num">${rankFmt(s.rank)}</td></tr>`).join("")}
      </tbody></table><p class="note">Best ever finish ${rankFmt(m.career.best)}. Typical finish ${rankFmt(m.career.median)}.</p>`
      : `<p class="note">No previous seasons on record. Accounts with no history are a common feature of AI assisted teams.</p>`}
    </div>
    ${txRows.length ? `<div class="dossier-section"><h4>Transfer highlights</h4><table class="mini-table"><thead><tr><th>GW</th><th>Out</th><th>In</th><th class="num">Net</th></tr></thead><tbody>
      ${txRows.map((t) => `<tr><td>${t.gw}</td><td>${esc(t.out)}</td><td>${esc(t.in)}</td><td class="num">${fmt(t.gain)}</td></tr>`).join("")}
    </tbody></table>${m.transfers.hitRate != null ? `<p class="note">${m.transfers.hitRate}% of their transfers outscored the player they sold.</p>` : ""}</div>` : ""}
    ${m.chipWaste.uses.length ? `<div class="dossier-section"><h4>Chip record</h4><table class="mini-table"><thead><tr><th>GW</th><th>Chip</th><th>Outcome</th><th class="num">Wasted</th></tr></thead><tbody>
      ${m.chipWaste.uses.map((c) => `<tr><td>${c.gw}</td><td>${CHIPS[c.name] || c.name}</td><td>${esc(c.text)}</td><td class="num">${c.waste}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    ${m.exBack.list.length ? `<div class="dossier-section"><h4>Ex back syndrome</h4><table class="mini-table"><thead><tr><th>Player</th><th>Sold</th><th>Back</th><th class="num">Price change</th></tr></thead><tbody>
      ${m.exBack.list.map((x) => `<tr><td>${esc(x.player)}</td><td>GW${x.soldGw} at £${x.soldFor.toFixed(1)}m</td><td>GW${x.backGw} at £${x.paid.toFixed(1)}m</td><td class="num">${x.paid - x.soldFor >= 0 ? "+" : ""}£${(x.paid - x.soldFor).toFixed(1)}m</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    ${caps.length ? `<div class="dossier-section"><h4>Captaincy record</h4><table class="mini-table"><thead><tr><th>GW</th><th>Captain</th><th class="num">Points</th><th class="num">Luck</th></tr></thead><tbody>
      ${caps.map((c) => `<tr><td>${c.gw}</td><td>${esc(c.player)}</td><td class="num">${c.pts}</td><td class="num">${fmt(c.luck)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    <div class="dossier-section">
      <h4>AI usage indicators</h4>
      ${m.ai.tells.length ? `<ul class="reasons">${m.ai.tells.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="note">No indicators detected. Decisions appear to be the manager's own.</p>`}
      ${m.chips.length ? `<p class="note">Chips played: ${m.chips.map((c) => `${CHIPS[c.name] || c.name} (GW${c.gw})`).join(", ")}.</p>` : ""}
      <p class="note"><a class="ext" href="https://fantasy.premierleague.com/entry/${m.id}/event/${data.meta.gw}" target="_blank" rel="noopener">See their team on the FPL site</a></p>
    </div>`;
  $(".close", dlg).onclick = () => dlg.close();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.onclose = () => history.replaceState(null, "", location.pathname);
  history.replaceState(null, "", `#m${m.id}`);
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}

init();
