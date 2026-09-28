"""Quarterly fundamentals from SEC EDGAR (free, official, no API key).

Key rule to avoid look-ahead bias: each value is dated by its FILING date
(when investors could first see it), not by the quarter-end date.
If a number was later restated, we keep the FIRST reported value,
because that is what the market knew at the time.

Output: a long table with columns [end, filed, metric, value].
"""
import time
import zlib

import numpy as np
import pandas as pd
import requests

from .config import SEC_USER_AGENT

TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

# metric -> (XBRL concept names to try, unit, "duration" or "instant")
CONCEPTS = {
    "revenue": (["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                 "SalesRevenueNet"], "USD", "duration"),
    "net_income": (["NetIncomeLoss"], "USD", "duration"),
    "eps_diluted": (["EarningsPerShareDiluted"], "USD/shares", "duration"),
    "assets": (["Assets"], "USD", "instant"),
    "liabilities": (["Liabilities"], "USD", "instant"),
}
FORMS = {"10-Q", "10-K", "10-Q/A", "10-K/A"}
EMPTY = pd.DataFrame(columns=["end", "filed", "metric", "value"])


def _get(url: str) -> dict:
    headers = {"User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate"}
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    time.sleep(0.2)  # stay well under the SEC limit of 10 requests per second
    return r.json()


def load_cik_map() -> dict:
    data = _get(TICKER_MAP_URL)
    return {v["ticker"].upper(): int(v["cik_str"]) for v in data.values()}


def _extract(facts: dict, names: list, unit: str, kind: str) -> pd.DataFrame:
    rows = []
    usgaap = facts.get("facts", {}).get("us-gaap", {})
    for name in names:
        for f in usgaap.get(name, {}).get("units", {}).get(unit, []):
            if f.get("form") not in FORMS:
                continue
            end = pd.Timestamp(f["end"])
            if kind == "duration":
                # keep single quarters only (about 90 days); skips 6-, 9-, 12-month totals
                if "start" not in f or not 80 <= (end - pd.Timestamp(f["start"])).days <= 100:
                    continue
            rows.append({"end": end, "filed": pd.Timestamp(f["filed"]), "value": float(f["val"])})
    if not rows:
        return pd.DataFrame(columns=["end", "filed", "value"])
    df = pd.DataFrame(rows).sort_values("filed")
    return df.drop_duplicates("end", keep="first")  # first report of each quarter


def _to_long(tables: dict) -> pd.DataFrame:
    parts = [t.assign(metric=m) for m, t in tables.items() if not t.empty]

    # Revenue growth vs. the same quarter one year earlier
    rev = tables.get("revenue")
    if rev is not None and len(rev) > 4:
        r = rev.sort_values("end").copy()
        r["lookup"] = r["end"] - pd.Timedelta(days=365)
        prev = r[["end", "value"]].rename(columns={"end": "prev_end", "value": "prev_value"})
        r = pd.merge_asof(r.sort_values("lookup"), prev.sort_values("prev_end"),
                          left_on="lookup", right_on="prev_end",
                          direction="nearest", tolerance=pd.Timedelta(days=20))
        r["value"] = r["value"] / r["prev_value"] - 1
        parts.append(r.dropna(subset=["value"]).assign(metric="rev_yoy"))

    if not parts:
        return EMPTY.copy()
    out = pd.concat([p[["end", "filed", "metric", "value"]] for p in parts], ignore_index=True)
    for c in ("end", "filed"):
        out[c] = pd.to_datetime(out[c]).astype("datetime64[ns]")
    return out.sort_values(["filed", "end"]).reset_index(drop=True)


def fetch_fundamentals(ticker: str, cik_map: dict) -> pd.DataFrame:
    cik = cik_map.get(ticker.upper())
    if cik is None:
        return EMPTY.copy()
    facts = _get(FACTS_URL.format(cik=cik))
    tables = {m: _extract(facts, *spec) for m, spec in CONCEPTS.items()}
    out = _to_long(tables)
    print(f"  fundamentals: {ticker} ({out['filed'].nunique()} filings)")
    return out


def synthetic_fundamentals(ticker: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """Fake quarterly reports filed about 35 days after each quarter end."""
    rng = np.random.default_rng(zlib.crc32(ticker.encode()) + 1)
    ends = pd.date_range(start - pd.DateOffset(years=1), end, freq="QE")
    n = len(ends)
    revenue = 1e9 * np.exp(np.cumsum(rng.normal(0.02, 0.05, n)))
    margin = np.clip(0.15 + np.cumsum(rng.normal(0, 0.01, n)), 0.02, 0.4)
    assets = revenue * 4
    base = pd.DataFrame({"end": ends, "filed": ends + pd.Timedelta(days=35)})
    base = base[base["filed"] <= end]
    k = len(base)
    tables = {
        "revenue": base.assign(value=revenue[:k]),
        "net_income": base.assign(value=(revenue * margin)[:k]),
        "eps_diluted": base.assign(value=(revenue * margin / 1e9)[:k]),
        "assets": base.assign(value=assets[:k]),
        "liabilities": base.assign(value=(assets * rng.uniform(0.4, 0.7, n))[:k]),
    }
    return _to_long(tables)
