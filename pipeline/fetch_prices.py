"""Daily end-of-day prices (open, high, low, close, volume).

Main source: yfinance (free, unofficial Yahoo data, split/dividend adjusted).
Backup source: Stooq CSV (free, no key).
Demo mode: synthetic prices, for running offline or in class.
"""
import zlib

import numpy as np
import pandas as pd

COLS = ["open", "high", "low", "close", "volume"]


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df.index = pd.to_datetime(df.index).tz_localize(None).astype("datetime64[ns]")
    df.index.name = "date"
    df = df[COLS].astype(float).dropna(subset=["close"])
    return df[~df.index.duplicated(keep="last")].sort_index()


def fetch_yfinance(ticker: str, years: int) -> pd.DataFrame:
    import yfinance as yf

    df = yf.download(ticker, period=f"{years}y", interval="1d",
                     auto_adjust=True, progress=False)
    if df is None or df.empty:
        raise ValueError(f"yfinance returned no data for {ticker}")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    return _clean(df)


def fetch_stooq(ticker: str, years: int) -> pd.DataFrame:
    url = f"https://stooq.com/q/d/l/?s={ticker.lower()}.us&i=d"
    df = pd.read_csv(url)
    if df.empty or "Close" not in df.columns:
        raise ValueError(f"Stooq returned no data for {ticker}")
    df = df.rename(columns=str.lower).set_index("date")
    df = _clean(df)
    start = df.index.max() - pd.DateOffset(years=years)
    return df[df.index >= start]


def synthetic_prices(ticker: str, years: int) -> pd.DataFrame:
    """Random-walk prices with changing volatility. Same ticker -> same data."""
    rng = np.random.default_rng(zlib.crc32(ticker.encode()))
    end = pd.Timestamp.today().normalize() - pd.offsets.BDay(1)
    dates = pd.bdate_range(end=end, periods=252 * years)
    vol = 0.012 * np.exp(np.cumsum(rng.normal(0, 0.03, len(dates))).clip(-1, 1))
    rets = rng.normal(0.0003, 1, len(dates)) * vol
    close = 50 * (1 + zlib.crc32(ticker.encode()) % 5) * np.exp(np.cumsum(rets))
    df = pd.DataFrame(index=dates)
    df["close"] = close
    df["open"] = close * (1 + rng.normal(0, 0.003, len(dates)))
    df["high"] = df[["open", "close"]].max(axis=1) * 1.005
    df["low"] = df[["open", "close"]].min(axis=1) * 0.995
    df["volume"] = rng.integers(1_000_000, 5_000_000, len(dates)).astype(float)
    return _clean(df)


def get_prices(ticker: str, years: int, demo: bool = False) -> pd.DataFrame:
    if demo:
        return synthetic_prices(ticker, years)
    errors = []
    for source in (fetch_yfinance, fetch_stooq):
        try:
            df = source(ticker, years)
            print(f"  prices: {ticker} from {source.__name__} ({len(df)} days)")
            return df
        except Exception as e:  # try the next source
            errors.append(f"{source.__name__}: {e}")
    raise RuntimeError(f"No price source worked for {ticker}: {errors}")
