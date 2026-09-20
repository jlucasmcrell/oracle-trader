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
