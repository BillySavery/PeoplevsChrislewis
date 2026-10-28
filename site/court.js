const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const rankFmt = (r) => (r == null ? "n/a" : r >= 1e6 ? `${(r / 1e6).toFixed(2)}m` : r >= 1e3 ? `${Math.round(r / 1e3)}k` : r);

async function init() {
  const res = await fetch(`data.json?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    $("#case").textContent = "The court record has not been compiled yet.";
    return;
  }
  const data = await res.json();
  const c = data.court;
  $("#gw").textContent = data.meta.gw;
  $("#foot").textContent = `Court record compiled automatically from official FPL data by detection model 2.4. Last updated ${new Date(data.meta.generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`;

  if (!c || !c.found) {
    $("#case").textContent = `The defendant${c?.name ? `, ${c.name},` : ""} could not be found in this league. Check the defendant name in config.json.`;
    return;
  }

  document.title = `The People v ${c.name}`;
  $("#title").textContent = `The People v ${c.name}`;
  $("#case").textContent = `Case ${c.caseNo}. The defendant manages ${c.team} and sits ${ordinal(c.rank)} in the league on ${c.total} points.`;
  const stamp = $("#stamp");
  stamp.hidden = false;
  stamp.textContent = c.outcome;
  stamp.classList.toggle("hung", c.outcome === "Hung jury");

  const seats = Array.from({ length: c.jury.total }, (_, i) =>
    `<span class="seat ${i < c.jury.guilty ? "g" : "n"}" title="${i < c.jury.guilty ? "Guilty" : "Not guilty"}"></span>`).join("");

  $("#court").innerHTML = `
    <section aria-labelledby="ind-h">
      <h2 id="ind-h">The indictment</h2>
      <p class="lede">${esc(c.name)} stands accused of the following ${c.counts.length === 1 ? "offence" : `${c.counts.length} offences`} against the league.</p>
      <ol class="counts">
        ${c.counts.map((k) => `
          <li>
            <p class="count-no">Count ${k.no}</p>
            <h3>${esc(k.title)}</h3>
            <p class="evidence">${esc(k.evidence)}</p>
            <p class="finding"><strong>${esc(k.finding)}.</strong> Ranked ${ordinal(k.rankInLeague)} worst in the league on this measure.</p>
          </li>`).join("")}
      </ol>
    </section>

    <section class="statements" aria-labelledby="pros-h">
      <div>
        <h2 id="pros-h">Case for the prosecution</h2>
        <p class="statement">${esc(c.prosecution)}</p>
      </div>
      <div>
        <h2>Case for the defence</h2>
        <p class="statement">${esc(c.defence)}</p>
      </div>
    </section>

    <section aria-labelledby="jury-h">
      <h2 id="jury-h">The jury</h2>
      <div class="jury" role="img" aria-label="${c.jury.guilty} of ${c.jury.total} jurors voted guilty">${seats}</div>
      <p class="lede">${c.jury.guilty} of ${c.jury.total} jurors voted guilty.</p>
    </section>

    <section class="sentence-block" aria-labelledby="sent-h">
      <h2 id="sent-h">Verdict and sentence</h2>
      <p class="outcome">${esc(c.outcome)}</p>
      <p class="statement">${esc(c.summing)}</p>
      <p class="sentence"><span>Sentence</span>${esc(c.sentence)}</p>
    </section>

    <section aria-labelledby="rec-h">
      <h2 id="rec-h">Previous convictions</h2>
      ${c.record.length ? `<table class="mini-table"><thead><tr><th>Season</th><th class="num">Points</th><th class="num">Overall rank</th></tr></thead><tbody>
        ${c.record.map((r) => `<tr><td>${esc(r.season)}</td><td class="num">${r.points}</td><td class="num">${rankFmt(r.rank)}</td></tr>`).join("")}
      </tbody></table>` : `<p class="lede">No previous seasons on record. The court notes this is consistent with an assisted account.</p>`}
    </section>

    <section aria-labelledby="next-h">
      <h2 id="next-h">Next hearing</h2>
      <p class="lede">The case will be reviewed automatically after gameweek ${c.nextHearing}. <a href="./#m${c.id}">Read the full dossier on ${esc(c.name)}</a>.</p>
    </section>`;
}

init();
