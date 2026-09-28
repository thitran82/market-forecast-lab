"""Three models, compared honestly on the same recent test period.

Target: log return from today's close to the close h trading days later.

- naive: predicts no change (random walk). The baseline every model must beat.
- ridge: linear regression on price features.
- gbm:   gradient boosting on price AND fundamental features (handles missing values).

Forecast range: we look at the model's errors on the test period and take the
10th and 90th percentiles (for an 80% range). This is "split conformal"
prediction: the range is as wide as the model's real past mistakes.
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import FUND_FEATURES, PRICE_FEATURES

MODELS = {
    "naive": {"features": [], "make": None},
    "ridge": {"features": PRICE_FEATURES,
              "make": lambda: make_pipeline(StandardScaler(), Ridge(alpha=10.0))},
    "gbm": {"features": PRICE_FEATURES + FUND_FEATURES,
            "make": lambda: HistGradientBoostingRegressor(
                max_iter=200, learning_rate=0.05, max_depth=3,
                min_samples_leaf=40, l2_regularization=1.0, random_state=0)},
}
MIN_ROWS = 300
TEST_SHARE = 0.2


def fit_horizon(feats: pd.DataFrame, close: pd.Series, h: int, interval: float):
    """Backtest each model on the recent test period, then refit on all known data.

    Returns fitted models, error quantiles for the range, and test metrics, or None.
    """
    lc = np.log(close)
    y = lc.shift(-h) - lc                      # future return (unknown for the last h days)
    known = feats[PRICE_FEATURES].notna().all(axis=1) & y.notna()
    Xk, yk = feats[known], y[known]
    if len(Xk) < MIN_ROWS:
        return None

    split = int(len(Xk) * (1 - TEST_SHARE))
    # Leave a gap of h days so training targets do not overlap the test period.
    Xtr, ytr = Xk.iloc[: split - h], yk.iloc[: split - h]
    Xte, yte = Xk.iloc[split:], yk.iloc[split:]
    alpha = (1 - interval) / 2
    naive_mae = float(np.mean(np.abs(yte)))

    fitted = {}
    for name, spec in MODELS.items():
        cols = spec["features"]
        if spec["make"] is None:
            pred_te, full = np.zeros(len(yte)), None
        else:
            pred_te = spec["make"]().fit(Xtr[cols], ytr).predict(Xte[cols])
            full = spec["make"]().fit(Xk[cols], yk)   # refit on all known data
        resid = yte.to_numpy() - pred_te
        q_lo, q_hi = np.quantile(resid, [alpha, 1 - alpha])
        mae = float(np.mean(np.abs(resid)))
        fitted[name] = {
            "model": full, "cols": cols, "q_lo": float(q_lo), "q_hi": float(q_hi),
            "metrics": {
                "mae": mae,
                "mae_vs_naive": mae / naive_mae if naive_mae > 0 else None,
                "hit_rate": (float(np.mean(np.sign(pred_te) == np.sign(yte.to_numpy())))
                             if full is not None else None),
                "test_start": str(Xte.index[0].date()),
                "test_days": int(len(Xte)),
            },
        }
    return fitted


def predict_horizon(fitted: dict, latest: pd.DataFrame) -> dict:
    """Forecast log return and range from one row of features."""
    out = {}
    for name, f in fitted.items():
        point = 0.0 if f["model"] is None else float(f["model"].predict(latest[f["cols"]])[0])
        out[name] = {"ret": point, "ret_lo": point + f["q_lo"], "ret_hi": point + f["q_hi"]}
    return out
