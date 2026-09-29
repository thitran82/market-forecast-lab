"""Daily job: fetch data, train models, forecast, and save JSON for the website.

Usage:
  python -m pipeline.run_daily                 # normal daily run
  python -m pipeline.run_daily --backfill 80   # also re-create forecasts for the past 80 trading days
  python -m pipeline.run_daily --demo --backfill 80   # synthetic data, no internet needed

Every run ADDS forecasts ("vintages") to web/data/forecasts/<TICKER>.json.
Old forecasts are never overwritten, so the site can show how forecasts changed.
"""
import argparse
import sys
import traceback
import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config
from .features import build_features
from .fetch_fundamentals import EMPTY, fetch_fundamentals, load_cik_map, synthetic_fundamentals
from .fetch_prices import get_prices
from .features import PRICE_FEATURES
from .models import MODELS, fit_horizon, predict_horizon


def _date(ts) -> str:
    return pd.Timestamp(ts).strftime("%Y-%m-%d")


def _r(v, n=4):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), n)


def forecast_one(prices, market, fund, as_of=None, cache=None, refit_every=1, live=True):
    """Forecast all horizons from the close of `as_of` (default: latest day).

    `cache` keeps fitted models between calls; models are refit when they are
    `refit_every` or more trading days old. Daily runs refit every time.
    """
    if as_of is not None:
        prices = prices[prices.index <= as_of]
        market = market[market.index <= as_of]
    cache = {} if cache is None else cache
    feats = build_features(prices, market, fund)
    latest = feats.iloc[[-1]]
    last_date = prices.index[-1]
    last_close = float(prices["close"].iloc[-1])
    rows, metrics = [], {}
    if latest[PRICE_FEATURES].isna().any(axis=1).iloc[0]:
        return last_date, last_close, rows, metrics
    n_days = len(prices)
    for label, h in config.HORIZONS.items():
        c = cache.get(label)
        if c is None or n_days - c["n_days"] >= refit_every:
            fitted = fit_horizon(feats, prices["close"], h, config.INTERVAL)
            if fitted is None:
                continue
            c = cache[label] = {"fitted": fitted, "n_days": n_days}
        res = predict_horizon(c["fitted"], latest)
        # Note: BDay skips weekends but not market holidays.
        target = _date(last_date + pd.offsets.BDay(h))
        metrics[label] = {m: {k: (_r(v) if isinstance(v, float) else v)
                              for k, v in f["metrics"].items()}
                          for m, f in c["fitted"].items()}
        for m, r in res.items():
            rows.append({
                "run_date": _date(last_date), "horizon": label, "h": h, "target_date": target,
                "model": m, "base": round(last_close, 2),
                "point": round(last_close * math.exp(r["ret"]), 2),
                "lo": round(last_close * math.exp(r["ret_lo"]), 2),
                "hi": round(last_close * math.exp(r["ret_hi"]), 2),
                "live": live,   # False = reconstructed later by --backfill
            })
    return last_date, last_close, rows, metrics


def load_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))


def merge_vintages(store: list, rows: list) -> list:
    """Replace forecasts from the same run date (safe re-runs), keep everything else.

    A live forecast is never replaced by a reconstructed (backfill) one.
    """
    live_dates = {r["run_date"] for r in store if r.get("live")}
    rows = [r for r in rows if r["live"] or r["run_date"] not in live_dates]
    run_dates = {r["run_date"] for r in rows}
    kept = [r for r in store if r["run_date"] not in run_dates]
    return sorted(kept + rows, key=lambda r: (r["run_date"], r["h"], r["model"]))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--demo", action="store_true", help="use synthetic data (no internet)")
    p.add_argument("--backfill", type=int, default=0, help="also forecast from the past N trading days")
    p.add_argument("--tickers", nargs="*", default=config.TICKERS)
    args = p.parse_args()

    data = config.DATA_DIR
    market = get_prices(config.MARKET, config.HISTORY_YEARS, args.demo)
    cik_map = {}
    if not args.demo:
        try:
            cik_map = load_cik_map()
        except Exception as e:
            print(f"WARNING: could not load SEC ticker list, fundamentals skipped: {e}")

    # Never mix demo and real forecasts: switching mode starts the history fresh.
    old_meta = load_json(data / "meta.json", {})
    fresh = bool(old_meta) and old_meta.get("demo") != args.demo
    if fresh:
        print("Mode changed (demo <-> real): starting forecast history from scratch.")
        for f in (data / "forecasts").glob("*.json"):
            f.unlink()
        (data / "meta.json").unlink()

    meta_rows, failed = [], []
    for t in args.tickers:
        print(f"{t}:")
        try:
            prices = market if t == config.MARKET else get_prices(t, config.HISTORY_YEARS, args.demo)
        except Exception as e:
            print(f"  SKIPPED (no prices): {e}")
            failed.append(t)
            continue

        fund = EMPTY.copy()
        if t != config.MARKET:
            try:
                fund = (synthetic_fundamentals(t, prices.index[0], prices.index[-1]) if args.demo
                        else fetch_fundamentals(t, cik_map))
            except Exception as e:
                print(f"  fundamentals unavailable, using prices only: {e}")

        path = data / "forecasts" / f"{t}.json"
        store = load_json(path, {"ticker": t, "vintages": []})["vintages"]
        run_dates = prices.index[-(args.backfill + 1):] if args.backfill else prices.index[-1:]
        metrics, last_date, last_close, cache = {}, None, None, {}
        try:
            for i, d in enumerate(run_dates):
                is_last = i == len(run_dates) - 1
                # Backfill days reuse models for up to 5 days; the latest day always refits.
                last_date, last_close, rows, metrics = forecast_one(
                    prices, market, fund, as_of=d, cache=cache,
                    refit_every=1 if is_last else config.BACKFILL_REFIT_EVERY, live=is_last)
                store = merge_vintages(store, rows)
        except Exception:
            print(f"  FAILED while forecasting {t}; other stocks continue:")
            traceback.print_exc()
            failed.append(t)
            continue
        save_json(path, {"ticker": t, "vintages": store})

        web = prices.iloc[-config.WEB_PRICE_DAYS:]
        filings = sorted({_date(x) for x in fund["filed"]}) if not fund.empty else []
        save_json(data / "prices" / f"{t}.json", {
            "ticker": t,
            "dates": [_date(x) for x in web.index],
            "close": [round(float(x), 2) for x in web["close"]],
            "filings": [f for f in filings if f >= _date(web.index[0])],
        })
        meta_rows.append({"ticker": t, "last_date": _date(last_date), "last_close": round(last_close, 2),
                          "has_fundamentals": not fund.empty, "metrics": metrics})
        print(f"  done: {len(store)} forecasts stored")

    # Keep entries for tickers that were not part of this run (e.g. a partial run).
    old = {r["ticker"]: r for r in load_json(data / "meta.json", {}).get("tickers", [])}
    old.update({r["ticker"]: r for r in meta_rows})
    order = [t for t in config.TICKERS if t in old] + [t for t in old if t not in config.TICKERS]
    meta_rows = [old[t] for t in order]

    save_json(data / "meta.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "demo": args.demo,
        "interval": config.INTERVAL,
        "horizons": config.HORIZONS,
        "models": list(MODELS.keys()),
        "tickers": meta_rows,
    })

    if failed:
        print(f"Finished with problems. Failed: {', '.join(failed)}")
    if not meta_rows:
        sys.exit("No stock was forecast successfully.")   # fail the job only if everything failed


if __name__ == "__main__":
    main()
