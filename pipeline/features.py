"""Turn prices and filings into one row of features per trading day.

Every feature on day t uses only information available at the close of day t.
"""
import numpy as np
import pandas as pd

PRICE_FEATURES = [
    "ret_1", "ret_5", "ret_10", "ret_21", "ret_63",   # past log returns
    "vol_21", "vol_63",                                # recent volatility
    "ma_gap_50", "ma_gap_200",                         # distance from moving averages
    "volume_trend",                                    # 5-day vs 21-day average volume
    "mkt_ret_5", "mkt_ret_21", "mkt_vol_21",           # market (SPY) context
]
FUND_FEATURES = ["rev_yoy", "net_margin", "eps_diluted", "liab_to_assets", "days_since_filing"]
FUND_METRICS = ["revenue", "net_income", "eps_diluted", "assets", "liabilities", "rev_yoy"]


def build_features(prices: pd.DataFrame, market: pd.DataFrame, fund: pd.DataFrame) -> pd.DataFrame:
    df = pd.DataFrame(index=prices.index)
    close = prices["close"]
    lc = np.log(close)
    r1 = lc.diff()

    for k in (1, 5, 10, 21, 63):
        df[f"ret_{k}"] = lc.diff(k)
    df["vol_21"] = r1.rolling(21).std()
    df["vol_63"] = r1.rolling(63).std()
    df["ma_gap_50"] = close / close.rolling(50).mean() - 1
    df["ma_gap_200"] = close / close.rolling(200).mean() - 1
    vol = prices["volume"].replace(0, np.nan)
    df["volume_trend"] = np.log(vol.rolling(5).mean() / vol.rolling(21).mean())

    mlc = np.log(market["close"]).reindex(df.index).ffill()
    df["mkt_ret_5"] = mlc.diff(5)
    df["mkt_ret_21"] = mlc.diff(21)
    df["mkt_vol_21"] = mlc.diff().rolling(21).std()

    return add_fundamentals(df, fund)


def add_fundamentals(df: pd.DataFrame, fund: pd.DataFrame) -> pd.DataFrame:
    for c in FUND_FEATURES:
        df[c] = np.nan
    if fund is None or fund.empty:
        return df

    f = fund.copy()
    # A filing can arrive during trading hours, so we only use it from the NEXT trading day.
    f["avail"] = (f["filed"] + pd.offsets.BDay(1)).astype("datetime64[ns]")
    f = f.sort_values(["avail", "end"])

    base = pd.DataFrame({"date": df.index.astype("datetime64[ns]")})
    for metric in FUND_METRICS:
        s = (f[f["metric"] == metric][["avail", "value"]]
             .drop_duplicates("avail", keep="last")
             .rename(columns={"value": metric}))
        if s.empty:
            base[metric] = np.nan
            continue
        base = pd.merge_asof(base, s, left_on="date", right_on="avail",
                             direction="backward").drop(columns="avail")

    filings = f[["avail"]].drop_duplicates().assign(last_filing=lambda d: d["avail"])
    base = pd.merge_asof(base, filings, left_on="date", right_on="avail",
                         direction="backward").drop(columns="avail")

    base["days_since_filing"] = (base["date"] - base["last_filing"]).dt.days
    base["net_margin"] = base["net_income"] / base["revenue"]
    base["liab_to_assets"] = base["liabilities"] / base["assets"]
    for c in FUND_FEATURES:
        df[c] = base[c].to_numpy()
    return df.replace([np.inf, -np.inf], np.nan)
