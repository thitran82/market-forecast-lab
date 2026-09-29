// Market Forecast Lab front end. Reads JSON from data/ and draws charts. No build step.

const HORIZON_NAMES = { "3d": "3 days", "7d": "7 days", "10d": "10 days", "1m": "1 month", "3m": "3 months" };
const ALGO_NAMES = { naive: "No-change guess", ridge: "Ridge regression", gbm: "Gradient boosting" };
const INPUT_NAMES = { price: "Own price", price_market: "+ Market", all: "+ Company filings" };
const INPUT_LONG = {
  price: "its own price history",
  price_market: "its own price history and the market",
  all: "price history, the market, and company filings",
};
const LEGACY_IDS = { ridge: "ridge:price_market", gbm: "gbm:all" }; // names used by older data files
const MODEL_ORDER = ["naive", ...["ridge", "gbm"].flatMap((a) => Object.keys(INPUT_NAMES).map((i) => `${a}:${i}`))];

// "gbm:all" -> "gradient boosting model (price history, the market, and company filings)"
function describeModel(id) {
  if (id === "naive") return "no-change guess";
  const [algo, inputs] = id.split(":");
  return `${ALGO_NAMES[algo].toLowerCase()} model using ${INPUT_LONG[inputs]}`;
}
function shortModel(id) {
  if (id === "naive") return ["No-change guess", "—"];
  const [algo, inputs] = id.split(":");
  return [ALGO_NAMES[algo], INPUT_NAMES[inputs]];
}
const HISTORY_DAYS = 126; // trading days of past prices on the main chart

const ALL_SECTORS = "All sectors";
const state = { meta: null, latest: null, sector: ALL_SECTORS, ticker: null, algo: "gbm", inputs: "all", horizon: "1m", prices: null, vintages: [], target: null };
// The selected model id, e.g. "gbm:all" or "naive".
Object.defineProperty(state, "model", {
  get() { return this.algo === "naive" ? "naive" : `${this.algo}:${this.inputs}`; },
});
const charts = {};

const $ = (id) => document.getElementById(id);
const money = (v) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctText = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%";
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

// Paints a solid background behind each chart. Without it the canvas is transparent,
// and dark-mode extensions that darken the page make the chart lines unreadable.
const backgroundPlugin = {
  id: "solidBackground",
  beforeDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = css("--paper");
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};
Chart.register(backgroundPlugin);

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
  return state.vintages.filter((v) => (model === null || v.model === model) && (!run || v.run_date === run));
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
  $("algos").innerHTML = Object.keys(ALGO_NAMES)
    .map((a) => `<button type="button" data-a="${a}" aria-pressed="${a === state.algo}">${ALGO_NAMES[a]}</button>`)
    .join("");
  const off = state.algo === "naive";
  $("inputs").innerHTML = Object.keys(INPUT_NAMES)
    .map((i) => `<button type="button" data-i="${i}" aria-pressed="${!off && i === state.inputs}" ${off ? "disabled" : ""}
      title="${off ? "The no-change guess uses no inputs" : ""}">${INPUT_NAMES[i]}</button>`)
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
  const article = /^(8|11|18)/.test(String(pct)) ? "an" : "a"; // "an 80%", "a 90%"
  $("headline").innerHTML =
    `In ${HORIZON_NAMES[state.horizon]} (${niceDate(row.target_date)}), the ${describeModel(state.model)} ` +
    `expects about <span class="num">${money(row.point)}</span>, with ${article} ${pct}% range of ` +
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

function renderCompare() {
  const run = latestRunDate();
  const rows = rowsFor({ run, model: null }).filter((r) => r.horizon === state.horizon);
  const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
  const m = tickerMeta().metrics[state.horizon] || {};
  const head = `<thead><tr><th>Method</th><th>Inputs</th><th>Low</th><th>Forecast</th><th>High</th>
    <th>Range width</th><th>Past error vs. no-change guess</th></tr></thead>`;
  const body = MODEL_ORDER.filter((id) => byModel[id]).map((id) => {
    const r = byModel[id];
    const [algoName, inputName] = shortModel(id);
    const ratio = m[id]?.mae_vs_naive;
    const cls = ratio != null && ratio < 1 ? "good" : "";
    return `<tr class="clickable ${id === state.model ? "selected" : ""}" data-model="${id}" tabindex="0">
      <td>${algoName}</td><td>${inputName}</td>
      <td>${money(r.lo)}</td><td>${money(r.point)}</td><td>${money(r.hi)}</td>
      <td>${money(r.hi - r.lo)}</td><td class="${cls}">${ratio == null ? "–" : ratio.toFixed(2)}</td></tr>`;
  }).join("");
  $("compare-table").innerHTML = head + `<tbody>${body}</tbody>`;

  // Say so when company filings add nothing for this stock (e.g. an ETF like SPY).
  const nAll = m["gbm:all"]?.n_features, nMkt = m["gbm:price_market"]?.n_features;
  $("compare-note").textContent = nAll != null && nAll === nMkt
    ? `No usable company-filing data for ${state.ticker}, so "+ Company filings" uses the same inputs as "+ Market".`
    : `${HORIZON_NAMES[state.horizon]} ahead, from the close on ${niceDate(run)}. Past error is measured on the same recent test period for every row.`;
}

// ---------- how it works: split, accuracy, update time ----------
function metricsFor(model = state.model) {
  return tickerMeta().metrics?.[state.horizon]?.[model];
}

// Scorecard: three honest percentages for the selected model and time frame.
function renderScorecard() {
  const m = metricsFor(), n = metricsFor("naive");
  $("score-sub").textContent = `${describeModel(state.model)}, ${HORIZON_NAMES[state.horizon]} ahead`;
  if (!m || !n) { $("scorecard").innerHTML = ""; $("score-note").textContent = ""; return; }
  const tile = (label, big, cls, sub) =>
    `<div class="tile"><p class="label">${label}</p><p class="big ${cls}">${big}</p><p class="sub">${sub}</p></div>`;
  const tiles = [];

  // 1. Direction right (test period)
  if (m.hit_rate == null) {
    tiles.push(tile("Direction right", "—", "", "The no-change guess never predicts up or down."));
  } else {
    const hr = Math.round(100 * m.hit_rate);
    tiles.push(tile("Direction right", `${hr}%`, hr > 50 ? "good" : "bad",
      `Called up vs. down correctly on ${m.test_days} test days. A coin flip gets 50%.`));
  }

  // 2. Error compared with the no-change guess (test period)
  const err = 100 * m.mae, nerr = 100 * n.mae;
  if (state.model === "naive") {
    tiles.push(tile("Average error", `${err.toFixed(1)}%`, "",
      "How far the price moved on average. Every model is compared with this."));
  } else {
    const diff = Math.round(100 * (1 - m.mae / n.mae));
    const big = diff === 0 ? "Same" : `${Math.abs(diff)}% ${diff > 0 ? "smaller" : "larger"}`;
    tiles.push(tile("Error compared with no-change guess", big, diff > 0 ? "good" : diff < 0 ? "bad" : "",
      `Average error ${err.toFixed(1)}% vs. ${nerr.toFixed(1)}% for the no-change guess, on the same test days.`));
  }

  // 3. Inside the range (forecasts whose target day has passed)
  const pct = Math.round(state.meta.interval * 100);
  const done = rowsFor({}).filter((r) => r.horizon === state.horizon)
    .map((r) => ({ r, a: actualFor(r.target_date) })).filter((x) => x.a);
  if (!done.length) {
    const next = rowsFor({}).filter((r) => r.horizon === state.horizon).map((r) => r.target_date).sort()[0];
    tiles.push(tile(`Inside the ${pct}% range`, "—", "",
      `No forecast has reached its target day yet${next ? `; the first is due ${niceDate(next)}` : ""}.`));
  } else {
    const inside = done.filter((x) => x.a.close >= x.r.lo && x.a.close <= x.r.hi).length;
    const cov = Math.round((100 * inside) / done.length);
    const live = done.filter((x) => x.r.live !== false).length;
    tiles.push(tile(`Inside the ${pct}% range`, `${cov}%`, Math.abs(cov - pct) <= 10 ? "good" : "bad",
      `Real price fell inside the range in ${inside} of ${done.length} checked forecasts ` +
      `(${live === 0 ? "all reconstructed by backfill" : live === done.length ? "all made live" : `${live} made live, the rest reconstructed`}). ` +
      `Target: about ${pct}%; much higher means the range is wider than needed.`));
  }

  $("scorecard").innerHTML = tiles.join("");
  $("score-note").innerHTML =
    `The first two numbers come from a test period the model never saw during training; the third checks forecasts ` +
    `against real prices after their target day. Blue means better than the benchmark (for the range: close to its ` +
    `${pct}% target); orange means worse or off target. ` +
    `<a href="#how">How we test</a>`;
}

function renderSplit() {
  const m = metricsFor(state.model === "naive" ? "gbm:all" : state.model) || metricsFor();
  if (!m || !m.train_start) {
    $("split-text").textContent = "Training dates appear after the next pipeline run.";
    $("timeline").innerHTML = "";
    return;
  }
  $("split-title").textContent = `Training and testing: ${state.ticker}, ${HORIZON_NAMES[state.horizon]}`;
  $("split-text").textContent =
    `Training: ${niceDate(m.train_start)} to ${niceDate(m.train_end)} (${m.train_days} trading days, about 80%). ` +
    `Gap: ${m.gap_days} trading days. ` +
    `Testing: ${niceDate(m.test_start)} to ${niceDate(m.test_end)} (${m.test_days} trading days, about 20%).`;
  const total = m.train_days + m.gap_days + m.test_days;
  const w = (d) => `${(100 * d) / total}%`;
  $("timeline").innerHTML =
    `<div class="train" style="width:${w(m.train_days)}">Training</div>` +
    `<div class="gap" style="width:${w(m.gap_days)}"></div>` +
    `<div class="test" style="width:${w(m.test_days)}">Testing</div>`;
}

function renderAccuracy() {
  const all = tickerMeta().metrics?.[state.horizon] || {};
  const naive = all.naive;
  if (!naive) { $("accuracy-table").innerHTML = ""; return; }
  const ids = [...new Set([state.model, "naive"])];
  const head = `<thead><tr><th>Model</th><th>Average error</th><th>Direction right</th>
    <th>"100% minus error" score</th><th>Error vs. no-change guess</th></tr></thead>`;
  const body = ids.filter((id) => all[id]).map((id) => {
    const m = all[id];
    const [algoName, inputName] = shortModel(id);
    const label = id === "naive" ? algoName : `${algoName} (${inputName})`;
    return `<tr class="${id === state.model ? "selected" : ""}"><td>${label}</td>
      <td>${(100 * m.mae).toFixed(1)}%</td>
      <td>${m.hit_rate == null ? "–" : Math.round(100 * m.hit_rate) + "%"}</td>
      <td>${(100 - 100 * m.mae).toFixed(1)}%</td>
      <td class="${m.mae_vs_naive < 1 ? "good" : ""}">${m.mae_vs_naive.toFixed(2)}</td></tr>`;
  }).join("");
  $("accuracy-table").innerHTML = head + `<tbody>${body}</tbody>`;
  const pct = Math.round(state.meta.interval * 100);
  $("accuracy-note").innerHTML =
    `${state.ticker}, ${HORIZON_NAMES[state.horizon]} ahead, measured on the test period. ` +
    `<strong>Why there is no single "96% accurate" number:</strong> the "100% minus error" score looks high for any model, ` +
    `even the no-change guess, because prices rarely move far in a short time. What matters is whether a model beats ` +
    `the no-change guess (error ratio below 1.00) and gets the direction right more often than a coin flip. ` +
    `The ${pct}% range was set from these same test errors, so its real reliability shows only on new days: ` +
    `see the Track record section.`;
}

function renderUpdated() {
  const t = new Date(state.meta.generated_at);
  $("updated").textContent = isNaN(t) ? "" :
    `Last update: ${t.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.`;
}

// ---------- sector comparison ----------
function tickersInSector() {
  return state.meta.tickers.filter((t) => state.sector === ALL_SECTORS || t.sector === state.sector);
}

function renderGroup() {
  const group = tickersInSector();
  $("group-title").textContent = state.sector === ALL_SECTORS ? "Compare all stocks" : `Compare stocks: ${state.sector}`;
  if (!state.latest) {
    $("group-table").innerHTML = "";
    $("group-summary").textContent = "This table appears after the next pipeline run.";
    return;
  }
  const model = state.model, h = state.horizon;
  const head = `<thead><tr><th>Stock</th><th>Sector</th><th>Close</th><th>Low</th><th>Forecast</th>
    <th>High</th><th>Past error vs. no-change guess</th></tr></thead>`;
  const body = group.map((t) => {
    const r = (state.latest[t.ticker] || []).find((x) => x.model === model && x.horizon === h);
    const ratio = t.metrics?.[h]?.[model]?.mae_vs_naive;
    if (!r) return `<tr><td>${t.ticker}</td><td>${t.sector || ""}</td><td colspan="5">No forecast yet</td></tr>`;
    const chg = (v) => v / r.base - 1;
    const dir = chg(r.point) >= 0 ? "up" : "down";
    return `<tr class="clickable ${t.ticker === state.ticker ? "selected" : ""}" data-ticker="${t.ticker}" tabindex="0">
      <td><strong>${t.ticker}</strong> <span class="muted">${t.name || ""}</span></td><td>${t.sector || ""}</td>
      <td>${money(r.base)}</td><td>${pctText(chg(r.lo))}</td><td class="${dir}">${pctText(chg(r.point))}</td>
      <td>${pctText(chg(r.hi))}</td>
      <td class="${ratio != null && ratio < 1 ? "good" : ""}">${ratio == null ? "–" : ratio.toFixed(2)}</td></tr>`;
  }).join("");
  $("group-table").innerHTML = head + `<tbody>${body}</tbody>`;
  $("group-summary").textContent = groupSummary(group, h);
}

// Plain-language summary: does the model beat the baseline, and do extra inputs help, in this group?
function groupSummary(group, h) {
  if (state.algo === "naive") {
    return "The no-change guess is the baseline. Pick ridge regression or gradient boosting to see how often a model beats it in this group.";
  }
  const algo = state.algo, name = ALGO_NAMES[algo].toLowerCase();
  const m = (t, inputs) => t.metrics?.[h]?.[`${algo}:${inputs}`];
  const withData = group.filter((t) => m(t, state.inputs));
  if (!withData.length) return "";
  const beat = withData.filter((t) => m(t, state.inputs).mae_vs_naive < 1).length;
  const mkt = group.filter((t) => m(t, "price") && m(t, "price_market"));
  const mktHelped = mkt.filter((t) => m(t, "price_market").mae < m(t, "price").mae).length;
  // Only stocks where filings actually added inputs (not SPY or stocks with missing filings).
  const fil = group.filter((t) => m(t, "price_market") && m(t, "all") && m(t, "all").n_features > m(t, "price_market").n_features);
  const filHelped = fil.filter((t) => m(t, "all").mae < m(t, "price_market").mae).length;
  let text = `${HORIZON_NAMES[h]} ahead, ${name} with "${INPUT_NAMES[state.inputs]}" beat the no-change guess for ` +
    `${beat} of ${withData.length} stocks. Adding market data lowered its past error for ${mktHelped} of ${mkt.length}`;
  text += fil.length ? `, and adding company filings for ${filHelped} of ${fil.length}.` : ".";
  return text;
}

function renderSectorSelect() {
  const sectors = [ALL_SECTORS, ...new Set(state.meta.tickers.map((t) => t.sector || "Other"))];
  $("sector").innerHTML = sectors.map((x) => `<option ${x === state.sector ? "selected" : ""}>${x}</option>`).join("");
}

function renderTickerSelect() {
  const group = tickersInSector();
  const opt = (t) => `<option value="${t.ticker}" ${t.ticker === state.ticker ? "selected" : ""}>${t.ticker}${t.name ? " — " + t.name : ""}</option>`;
  if (state.sector !== ALL_SECTORS) {
    $("ticker").innerHTML = group.map(opt).join("");
    return;
  }
  const bySector = {};
  group.forEach((t) => (bySector[t.sector || "Other"] ||= []).push(t));
  $("ticker").innerHTML = Object.entries(bySector)
    .map(([sec, ts]) => `<optgroup label="${sec}">${ts.map(opt).join("")}</optgroup>`).join("");
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
    <p class="note">For the ${describeModel(state.model)}. ${
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
  renderGroup();
  renderTable();
  renderCompare();
  renderTargetSelect();
  renderRevision();
  renderTrack();
  renderScorecard();
  renderSplit();
  renderAccuracy();
  renderUpdated();
}

// ---------- events ----------
async function loadTicker(t) {
  state.ticker = t;
  history.replaceState(null, "", "#" + t);
  renderTickerSelect();
  try {
    const [prices, fc] = await Promise.all([getJSON(`data/prices/${t}.json`), getJSON(`data/forecasts/${t}.json`)]);
    state.prices = prices;
    state.vintages = fc.vintages.map((v) => ({ ...v, model: LEGACY_IDS[v.model] || v.model }));
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
  if (b.dataset.a) { state.algo = b.dataset.a; renderAll(); }
  if (b.dataset.i) { state.inputs = b.dataset.i; renderAll(); }
});
function selectModel(id) {
  if (id === "naive") state.algo = "naive";
  else [state.algo, state.inputs] = id.split(":");
  renderAll();
}
$("compare-table").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-model]");
  if (tr) selectModel(tr.dataset.model);
});
$("compare-table").addEventListener("keydown", (e) => {
  const tr = e.target.closest("tr[data-model]");
  if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectModel(tr.dataset.model); }
});
$("ticker").addEventListener("change", (e) => loadTicker(e.target.value));
$("sector").addEventListener("change", (e) => {
  state.sector = e.target.value;
  const group = tickersInSector();
  const next = group.some((t) => t.ticker === state.ticker) ? state.ticker : group[0].ticker;
  renderTickerSelect();
  loadTicker(next);
});
function openTickerRow(e) {
  const tr = e.target.closest("tr[data-ticker]");
  if (!tr) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  loadTicker(tr.dataset.ticker);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("group-table").addEventListener("click", openTickerRow);
$("group-table").addEventListener("keydown", openTickerRow);
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
  state.meta.tickers.forEach((t) => {   // rename models saved by older versions
    Object.values(t.metrics || {}).forEach((byModel) => {
      Object.entries(LEGACY_IDS).forEach(([oldId, newId]) => {
        if (byModel[oldId] && !byModel[newId]) byModel[newId] = byModel[oldId];
      });
    });
  });
  try {
    state.latest = await getJSON("data/latest.json");
  } catch {
    state.latest = null; // older data: the sector table waits for the next pipeline run
  }
  if (state.latest) {   // rename models saved by older versions
    Object.values(state.latest).forEach((rows) => rows.forEach((v) => { v.model = LEGACY_IDS[v.model] || v.model; }));
  }
  const tickers = state.meta.tickers.map((t) => t.ticker);
  const fromHash = location.hash.slice(1).toUpperCase();
  const start = tickers.includes(fromHash) ? fromHash : tickers[0];
  renderSectorSelect();
  loadTicker(start);
})();
