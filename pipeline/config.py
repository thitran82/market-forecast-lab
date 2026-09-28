"""Central settings. Change tickers, horizons, and the interval here only."""
import os
from pathlib import Path

# Stocks to forecast. SPY (S&P 500 ETF) is also used as the "market" input.
TICKERS = ["AAPL", "MSFT", "NVDA", "AMZN", "JPM", "JNJ", "XOM", "WMT", "KO", "SPY"]
MARKET = "SPY"

# Forecast horizons in TRADING days (about 21 trading days per month).
HORIZONS = {"3d": 3, "7d": 7, "10d": 10, "1m": 21, "3m": 63}

# Width of the forecast range. 0.80 = an 80% range.
INTERVAL = 0.80

# Years of daily price history used for training.
HISTORY_YEARS = 8

# During --backfill, refit models every N trading days (daily runs always refit).
BACKFILL_REFIT_EVERY = 5

# Trading days of price history written for the website (about 3 years).
WEB_PRICE_DAYS = 756

# The SEC asks every API user to identify themselves.
# Set this as a GitHub secret named SEC_USER_AGENT, e.g. "Jane Doe jdoe@university.edu".
SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT", "Forecast Lab contact@example.edu")

# Output folder: the website reads everything from here.
DATA_DIR = Path(__file__).resolve().parents[1] / "web" / "data"
