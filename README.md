# Market Forecast Lab

A teaching app that forecasts stock prices 3, 7, and 10 trading days, 1 month, and 3 months ahead,
shows a range for each forecast, and records every forecast so you can see how it changed as the
target day got closer.

**For teaching only. Not investment advice.** Future events can move prices in ways no model can see.

## How it works

```
GitHub Actions (every weekday, 6:30 pm New York)
  1. Fetch daily prices      (yfinance, backup: Stooq)
  2. Fetch company filings   (SEC EDGAR, quarterly 10-Q / 10-K)
  3. Build features, train 3 models, forecast 5 time frames
  4. Save JSON to web/data/  and commit to the repo
                    |
                    v
Vercel (redeploys on every commit)
  Static website in web/ reads the JSON and draws the charts. No server code.
```

| Folder / file | What it does |
|---|---|
| `pipeline/config.py` | Stock list with names and sectors, time frames, range width. Change settings here only. |
| `pipeline/fetch_prices.py` | Daily prices, with a backup source and a demo (synthetic) mode. |
| `pipeline/fetch_fundamentals.py` | Quarterly company numbers from SEC EDGAR. |
| `pipeline/features.py` | Turns prices and filings into one row of features per day. |
| `pipeline/models.py` | Three models, a fair backtest, and the forecast range. |
| `pipeline/run_daily.py` | Runs everything and writes the JSON files. |
| `.github/workflows/daily-forecast.yml` | The daily schedule. |
| `web/` | The website (HTML, CSS, JavaScript, Chart.js). |

## Setup

1. **Create a GitHub repo** and push this folder to it.
2. **Add a secret.** In the repo: Settings → Secrets and variables → Actions → New repository secret.
   Name: `SEC_USER_AGENT`. Value: your name and email, for example `Jane Doe jdoe@binghamton.edu`.
   The SEC requires this for its free API.
3. **Allow the workflow to commit.** Settings → Actions → General → Workflow permissions →
   "Read and write permissions". (The workflow file also asks for this, but some accounts block it by default.)
4. **Run it once by hand with history.** Actions tab → "Daily forecast" → Run workflow →
   set backfill to `80`. This takes about 5–10 minutes and fills the revision chart and track record
   right away. After that it runs by itself every weekday.
5. **Connect Vercel.** New Project → import the repo → Framework Preset: **Other** →
   Root Directory: **`web`** → no build command → Deploy.

The repo ships with demo data, so the site works before step 4. The first real run detects the switch
from demo to real data and clears the demo forecasts, so the two never mix.

## Run it on your own computer

```bash
pip install -r requirements.txt
python -m pipeline.run_daily --demo --backfill 80   # synthetic data, no internet needed
# or: python -m pipeline.run_daily --backfill 80    # real data
cd web && python -m http.server 8000                # open http://localhost:8000
```

## Method in short

- **Target:** the log return from today's close to the close h trading days later.
- **Price features:** past returns (1 to 63 days), volatility, distance from 50- and 200-day averages,
  volume trend, and market (SPY) returns and volatility.
- **Fundamental features:** revenue growth vs. the same quarter last year, net margin, diluted EPS,
  liabilities to assets, and days since the last filing.
- **Methods:**
  - *No-change guess* (naive): the price stays the same. Every model must beat this.
  - *Ridge regression*: linear model (missing values filled with the training median).
  - *Gradient boosting*: tree model that can capture non-linear effects.
- **Inputs:** ridge and gradient boosting each run on three input sets, so users can see
  whether more information helps: *own price history*, *+ market (SPY)*, and *+ company filings*.
  With the no-change guess, that makes 7 variants per stock and time frame.
- **Backtest:** the last 20% of the history is held out as a test period, with a gap of h days so
  training and test targets never overlap.
- **Range:** the 10th and 90th percentiles of each model's test errors (split conformal prediction).
  So the 80% range is as wide as the model's real past mistakes.
- **Forecast history:** each run adds new forecasts and never overwrites old live ones.
  This is what the revision chart and track record use.

## Design choices worth discussing in class

1. **No look-ahead bias.** Each company number is used starting the trading day *after* its SEC filing
   date, not from the quarter-end date. If a number was restated later, the first reported value is kept,
   because that is what investors knew at the time.
2. **Baselines matter.** On the demo (random-walk) data, both ML models lose to the no-change guess.
   That is correct: there is nothing to predict. If a model "beats" a random walk, look for a leak.
3. **Does more information help?** The site's comparison table shows every method with each
   input set. Fundamentals change four times a year, so they may help 1- and 3-month forecasts more
   than 3-day ones. If adding inputs does not lower the past error, that information did not help.
4. **Live vs. reconstructed forecasts.** Backfilled forecasts are made later with today's data
   (adjusted prices, models refit weekly). They are tagged `live: false`, and the site says how many
   of the checked forecasts were reconstructed.
5. **Uncertainty shrinks as the day gets closer.** The revision chart shows the range narrowing and
   often a jump after a filing.

## Known limits

- yfinance is unofficial and sometimes breaks; the pipeline falls back to Stooq.
- Trading-day math skips weekends but not market holidays, so a target day can land on a holiday.
  The site then uses the next trading day's close.
- A bank's revenue is reported under different XBRL names, so some fundamentals may be missing for
  stocks like JPM. Gradient boosting handles missing values.
- Each stock's forecast file grows by about 0.5 MB per year. Trim old forecasts if needed.

## Change the setup

Edit `pipeline/config.py`:
- `STOCKS`: ticker → (company name, sector). Add or remove lines to change the stock list;
  the website's Sector and Stock menus follow automatically. After adding stocks, run the
  workflow with backfill 80 so they get forecast history.
- `HORIZONS` (in trading days) and `INTERVAL` (e.g. 0.90 for a 90% range).

To add a model, add an entry to `ALGORITHMS` in `pipeline/models.py`; it runs on all three
input sets. Add a display name in `ALGO_NAMES` in `web/app.js`.

Each stock adds about 5–10 seconds to the daily run and about 1.3 MB of forecast data per year.
Keep the list to a few dozen stocks: Yahoo may throttle many requests, and the dropdown gets long.
