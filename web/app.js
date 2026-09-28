// Market Forecast Lab front end. Reads JSON from data/ and draws charts. No build step.

const HORIZON_NAMES = { "3d": "3 days", "7d": "7 days", "10d": "10 days", "1m": "1 month", "3m": "3 months" };
const MODEL_NAMES = { naive: "No-change guess", ridge: "Ridge regression", gbm: "Gradient boosting" };
const HISTORY_DAYS = 126; // trading days of past prices on the main chart

const state = { meta: null, ticker: null, model: "gbm", horizon: "1m", prices: null, vintages: [], target: null };
const charts = {};

const $ = (id) => document.getElementById(id);
const money = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDate = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const shortDate = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not load ${path} (HTTP ${r.status}). Run the pipeline to create it.`);
  return r.json();
}

// Draws dashed vertical lines (company filings) on a category x-axis.
const markerPlugin = {
  id: "markers",
  afterDatasetsDraw(chart, _args, opts) {
    const idx = opts.indices || [];
    if (!idx.length) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.fillStyle = opts.color;
    ctx.setLineDash([4, 4]);
    ctx.font = "11px 'Public Sans', sans-serif";
    idx.forEach((i) => {
      const px = x.getPixelForValue(i);
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
      ctx.fillText("Filing", px + 4, top + 12);
    });
    ctx.restore();
  },
};

// ---------- data helpers ----------
// Weekdays after `start` up to and including `end` (YYYY-MM-DD strings), so charts keep real time spacing.
function weekdaysAfter(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (d < stop) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function latestRunDate() {
  return state.vintages.reduce((m, v) => (v.run_date > m ? v.run_date : m), "");
}
function rowsFor({ run, model = state.model }) {
  return state.vintages.filter((v) => v.model === model && (!run || v.run_date === run));
}
// Close on the target day, or the next trading day if the target was a holiday.
function actualFor(target) {
  const d = state.prices.dates;
  const last = d[d.length - 1];
  if (target > last) return null;
  let lo = 0, hi = d.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (d[mid] < target) lo = mid + 1; else hi = mid; }
  const gapDays = (new Date(d[lo]) - new Date(target)) / 86400000;
  return gapDays <= 5 ? { date: d[lo], close: state.prices.close[lo] } : null;
}
function tickerMeta() {
  return state.meta.tickers.find((t) => t.ticker === state.ticker);
}

// ---------- rendering ----------
function renderControls() {
  $("horizons").innerHTML = Object.keys(HORIZON_NAMES)
    .map((h) => `<button type="button" data-h="${h}" aria-pressed="${h === state.horizon}">${HORIZON_NAMES[h]}</button>`)
    .join("");
  $("models").innerHTML = state.meta.models
    .map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === state.model}">${MODEL_NAMES[m] || m}</button>`)
    .join("");
}

function renderHero() {
  const run = latestRunDate();
  const tm = tickerMeta();
  const row = rowsFor({ run }).find((r) => r.horizon === state.horizon);
  $("asof").textContent = `${state.ticker} closed at ${money(tm.last_close)} on ${niceDate(tm.last_date)}.`;
  if (!row) {
    $("headline").textContent = "No forecast is available for this time frame yet.";
    return;
  }
  const pct = Math.round(state.meta.interval * 100);
  $("headline").innerHTML =
    `In ${HORIZON_NAMES[state.horizon]} (${niceDate(row.target_date)}), the ${MODEL_NAMES[state.model].toLowerCase()} ` +
    `model expects about <span class="num">${money(row.point)}</span>, with a ${pct}% range of ` +
    `<span class="range">${money(row.lo)} to ${money(row.hi)}</span>.`;
  $("fan-note").textContent =
    `Shaded area: the ${pct}% range for each time frame. On a recent test period, about ${pct} in 100 ` +
    `real outcomes fell inside ranges this wide. Ranges get wider further out because more can change.`;
}

function renderFan() {
  const run = latestRunDate();
  const future = rowsFor({ run }).sort((a, b) => a.h - b.h);
  const d = state.prices.dates.slice(-HISTORY_DAYS);
  const c = state.prices.close.slice(-HISTORY_DAYS);
  const lastTarget = future.length ? future[future.length - 1].target_date : d[d.length - 1];
  const ahead = weekdaysAfter(d[d.length - 1], lastTarget);
  const labels = [...d, ...ahead];
  // Put each forecast on its real target day; days in between stay empty and the line spans them.
  const place = (key) => {
    const arr = Array(labels.length).fill(null);
    arr[d.length - 1] = c[c.length - 1];
    future.forEach((r) => { const i = labels.indexOf(r.target_date); if (i >= 0) arr[i] = r[key]; });
    return arr;
  };
  const selIdx = labels.indexOf(future.find((r) => r.horizon === state.horizon)?.target_date);
  const pointIdx = new Set(future.map((r) => labels.indexOf(r.target_date)));
  const filingIdx = state.prices.filings.map((f) => d.indexOf(f)).filter((i) => i > 0);
  const pct = Math.round(state.meta.interval * 100);

  charts.fan?.destroy();
  charts.fan = new Chart($("fan"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Closing price", data: [...c, ...ahead.map(() => null)], borderColor: css("--ink"),
          borderWidth: 1.75, pointRadius: 0, tension: 0 },
        { label: "Low end of range", data: place("lo"), borderColor: "transparent", pointRadius: 0, spanGaps: true },
        { label: `${pct}% range`, data: place("hi"), borderColor: "transparent",
          backgroundColor: css("--range-fill"), pointRadius: 0, fill: "-1", spanGaps: true },
        { label: "Forecast", data: place("point"), borderColor: css("--range"), spanGaps: true,
          borderWidth: 2, borderDash: [5, 4], backgroundColor: css("--range"),
          pointRadius: (ctx) => (ctx.dataIndex === selIdx ? 6 : pointIdx.has(ctx.dataIndex) ? 3 : 0) },
      ],
    },
    options: chartOptions({ markers: filingIdx }),
    plugins: [markerPlugin],
  });
}

function renderTable() {
  const run = latestRunDate();
  const rows = rowsFor({ run }).sort((a, b) => a.h - b.h);
  const m = tickerMeta().metrics;
  const head = `<thead><tr><th>Time frame</th><th>Target day</th><th>Low</th><th>Forecast</th><th>High</th>
    <th>Past error vs. no-change guess</th></tr></thead>`;
  const body = rows.map((r) => {
    const ratio = m[r.horizon]?.[state.model]?.mae_vs_naive;
    const ratioText = ratio == null ? "–" : ratio.toFixed(2);
    const cls = ratio != null && ratio < 1 ? "good" : "";
    return `<tr class="${r.horizon === state.horizon ? "selected" : ""}">
      <td>${HORIZON_NAMES[r.horizon]}</td><td>${niceDate(r.target_date)}</td>
      <td>${money(r.lo)}</td><td>${money(r.point)}</td><td>${money(r.hi)}</td>
      <td class="${cls}">${ratioText}</td></tr>`;
  }).join("");
  $("horizon-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

function targetOptions() {
  const counts = {};
  rowsFor({}).forEach((r) => { counts[r.target_date] = (counts[r.target_date] || 0) + 1; });
  return Object.keys(counts).filter((t) => counts[t] >= 2).sort().reverse().map((t) => ({ t, n: counts[t] }));
}

function renderTargetSelect() {
  const opts = targetOptions();
  if (!opts.length) { $("target").innerHTML = ""; state.target = null; return; }
  if (!opts.some((o) => o.t === state.target)) {
    // Default: the most recent target day that has the most forecasts.
    // Default: the latest target day with the most forecasts, preferring one whose outcome is known.
    const maxN = Math.max(...opts.map((o) => o.n));
    const best = opts.filter((o) => o.n === maxN);
    state.target = (best.find((o) => actualFor(o.t)) || best[0]).t;
  }
  $("target").innerHTML = opts
    .map((o) => {
      const done = actualFor(o.t) ? " (outcome known)" : "";
      return `<option value="${o.t}" ${o.t === state.target ? "selected" : ""}>${niceDate(o.t)} — ${o.n} forecasts${done}</option>`;
    })
    .join("");
}

function renderRevision() {
  charts.rev?.destroy();
  if (!state.target) {
    $("revision-note").textContent = "This chart needs forecasts from at least two different days. It fills in as the daily job runs.";
    return;
  }
  const vs = rowsFor({}).filter((r) => r.target_date === state.target).sort((a, b) => (a.run_date < b.run_date ? -1 : 1));
  const labels = [vs[0].run_date, ...weekdaysAfter(vs[0].run_date, vs[vs.length - 1].run_date)];
  const place = (key) => {
    const arr = Array(labels.length).fill(null);
    vs.forEach((v) => { const i = labels.indexOf(v.run_date); if (i >= 0) arr[i] = v[key]; });
    return arr;
  };
  const actual = actualFor(state.target);
  const filingIdx = state.prices.filings
    .filter((f) => f > labels[0] && f <= labels[labels.length - 1])
    .map((f) => labels.indexOf(f)).filter((i) => i >= 0);
  const pct = Math.round(state.meta.interval * 100);

  charts.rev = new Chart($("revision"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Low end of range", data: place("lo"), borderColor: "transparent", pointRadius: 0, spanGaps: true },
        { label: `${pct}% range`, data: place("hi"), borderColor: "transparent", spanGaps: true,
          backgroundColor: css("--range-fill"), pointRadius: 0, fill: "-1" },
        { label: "Forecast", data: place("point"), borderColor: css("--range"), backgroundColor: css("--range"),
          borderWidth: 2, pointRadius: 4, spanGaps: true },
        ...(actual ? [{ label: "Real close", data: labels.map(() => actual.close), borderColor: css("--outcome"),
          borderDash: [6, 4], borderWidth: 2, pointRadius: 0 }] : []),
      ],
    },
    options: chartOptions({ markers: filingIdx, xTitle: "Day the forecast was made" }),
    plugins: [markerPlugin],
  });

  const first = vs[0], last = vs[vs.length - 1];
  let text = `The range was ${money(first.hi - first.lo)} wide on ${niceDate(first.run_date)} ` +
    `(${HORIZON_NAMES[first.horizon]} ahead) and ${money(last.hi - last.lo)} wide on ${niceDate(last.run_date)} ` +
    `(${HORIZON_NAMES[last.horizon]} ahead).`;
  if (actual) {
    const inside = vs.filter((v) => actual.close >= v.lo && actual.close <= v.hi).length;
    text += ` The real close was ${money(actual.close)}; ${inside} of ${vs.length} ranges contained it.`;
  } else {
    text += " The real close is not known yet.";
  }
  $("revision-note").textContent = text;
}

function renderTrack() {
  const done = rowsFor({}).map((r) => ({ r, a: actualFor(r.target_date) })).filter((x) => x.a);
  if (!done.length) {
    const next = rowsFor({}).map((r) => r.target_date).sort()[0];
    $("track").innerHTML = `<p class="note">No forecast has reached its target day yet${next ? `. The first one is due ${niceDate(next)}` : ""}.</p>`;
    return;
  }
  const pct = Math.round(state.meta.interval * 100);
  const rows = Object.keys(HORIZON_NAMES).map((h) => {
    const xs = done.filter((x) => x.r.horizon === h);
    if (!xs.length) return `<tr><td>${HORIZON_NAMES[h]}</td><td>0</td><td>–</td><td>–</td></tr>`;
    const inside = xs.filter((x) => x.a.close >= x.r.lo && x.a.close <= x.r.hi).length;
    const mape = xs.reduce((s, x) => s + Math.abs(x.r.point - x.a.close) / x.a.close, 0) / xs.length;
    return `<tr><td>${HORIZON_NAMES[h]}</td><td>${xs.length}</td>
      <td>${Math.round((100 * inside) / xs.length)}%</td><td>${(100 * mape).toFixed(1)}%</td></tr>`;
  }).join("");
  $("track").innerHTML = `<table><thead><tr><th>Time frame</th><th>Forecasts checked</th>
    <th>Real close inside range (target ${pct}%)</th><th>Average error of forecast</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">For the ${MODEL_NAMES[state.model].toLowerCase()} model. ${
      done.filter((x) => x.r.live === false).length} of ${done.length} checked forecasts were reconstructed
    after the fact (backfill), not made live. Nearby days share most of their information, so a few dozen
    checks can still be noisy.</p>`;
}

function chartOptions({ markers = [], xTitle = "" } = {}) {
  const grid = css("--rule"), muted = css("--muted");
  return {
    responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: muted, boxWidth: 12, filter: (item) => !item.text.startsWith("Low end") } },
      tooltip: {
        filter: (item) => item.raw != null,
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${money(ctx.raw)}` },
      },
      markers: { indices: markers, color: muted },
    },
    scales: {
      x: { ticks: { color: muted, maxTicksLimit: 8, callback(v) { return shortDate(this.getLabelForValue(v)); } },
           grid: { display: false }, title: { display: !!xTitle, text: xTitle, color: muted } },
      y: { ticks: { color: muted, callback: (v) => money(v) }, grid: { color: grid } },
    },
  };
}

function renderAll() {
  renderControls();
  renderHero();
  renderFan();
  renderTable();
  renderTargetSelect();
  renderRevision();
  renderTrack();
}

// ---------- events ----------
async function loadTicker(t) {
  state.ticker = t;
  history.replaceState(null, "", "#" + t);
  try {
    const [prices, fc] = await Promise.all([getJSON(`data/prices/${t}.json`), getJSON(`data/forecasts/${t}.json`)]);
    state.prices = prices;
    state.vintages = fc.vintages;
    state.target = null;
    renderAll();
  } catch (e) {
    $("headline").innerHTML = `<span class="error">${e.message}</span>`;
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.h) { state.horizon = b.dataset.h; renderAll(); }
  if (b.dataset.m) { state.model = b.dataset.m; renderAll(); }
});
$("ticker").addEventListener("change", (e) => loadTicker(e.target.value));
$("target").addEventListener("change", (e) => { state.target = e.target.value; renderRevision(); });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.prices && renderAll());

(async function init() {
  try {
    state.meta = await getJSON("data/meta.json");
  } catch (e) {
    $("headline").innerHTML = `<span class="error">${e.message}</span>`;
    return;
  }
  $("demo-banner").hidden = !state.meta.demo;
  const tickers = state.meta.tickers.map((t) => t.ticker);
  $("ticker").innerHTML = tickers.map((t) => `<option>${t}</option>`).join("");
  const fromHash = location.hash.slice(1).toUpperCase();
  const start = tickers.includes(fromHash) ? fromHash : tickers[0];
  $("ticker").value = start;
  loadTicker(start);
})();
