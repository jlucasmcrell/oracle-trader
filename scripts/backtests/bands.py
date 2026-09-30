"""One band for every research script, identical to the app's (src/main/ladder/ladder.ts clusteredSe / clusterT).

Until 2026-09-19 the scripts drew day-clustered bands as mean +- 1.28 x sqrt(sum of squared cluster residual sums)/n:
no finite-cluster correction and the normal quantile at any cluster count. With two day-clusters that band is about
2-3x too narrow (external review GLM 5.3, F-01); the app itself had carried both corrections since section 127.

  se   = sqrt(G/(G-1)) x sqrt(sum_g r_g^2) / N        r_g = the cluster's summed residual around the pooled mean
  band = mean +- t(0.90, G-1) x se                     the same two-sided 80% the scripts always quoted
A single cluster has no band at all: (mean, None, None, 1).
"""
import math

# Student t, upper 0.90 quantile (two-sided 80%), by degrees of freedom.
_T90 = {1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.440, 7: 1.415, 8: 1.397, 9: 1.383, 10: 1.372,
        12: 1.356, 15: 1.341, 20: 1.325, 30: 1.310, 60: 1.296}


def t90(df):
    if df < 1:
        return float('inf')
    for k in sorted(_T90):
        if df <= k:
            return _T90[k]
    return 1.282


def cluster_se(residual_sums, n):
    """residual_sums: per-cluster sum of (x - pooled mean), or of weighted residuals; n: total weight."""
    g = len(residual_sums)
    if g < 2 or n <= 0:
        return None
    return math.sqrt(g / (g - 1)) * math.sqrt(sum(v * v for v in residual_sums)) / n


def cluster_band(mean, residual_sums, n):
    """(mean, lo, hi, clusters); lo/hi are None below two clusters."""
    g = len(residual_sums)
    se = cluster_se(residual_sums, n)
    if se is None:
        return mean, None, None, g
    k = t90(g - 1)
    return mean, mean - k * se, mean + k * se, g


# Student t, upper 0.975 quantile (two-sided 95%), by degrees of freedom. Some registrations fix a 95%
# band rather than the house 80% (docs/PREREGISTERED-polymarket-consensus.md, docs/PREREGISTERED-leadlag-coins.md).
_T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
         12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042, 60: 2.000}


def t975(df):
    if df < 1:
        return float('inf')
    for k in sorted(_T975):
        if df <= k:
            return _T975[k]
    return 1.960


def cluster_band95(mean, residual_sums, n):
    """cluster_band's two-sided 95% twin; same se, the 0.975 quantile."""
    g = len(residual_sums)
    se = cluster_se(residual_sums, n)
    if se is None:
        return mean, None, None, g
    k = t975(g - 1)
    return mean, mean - k * se, mean + k * se, g


def day_band95(rows, day_of, value_of):
    """Day-clustered 95% band over rows. (mean, lo, hi, clusters, n) with the pooled mean in value units."""
    vals = [float(value_of(r)) for r in rows]
    n = len(vals)
    if n == 0:
        return 0.0, None, None, 0, 0
    mean = sum(vals) / n
    days = {}
    for r, v in zip(rows, vals):
        days.setdefault(day_of(r), []).append(v)
    sums = [sum(v) - len(v) * mean for v in days.values()]
    m, lo, hi, g = cluster_band95(mean, sums, n)
    return m, lo, hi, g, n
