# Backtest: move audit (mean reversion vs momentum) on the Becker Kalshi dataset (2026-09-08)

Trades since 2024-10-01; 17,934,707 one-minute candles; 41,779 qualifying moves (>= 8c in 10 min, >= 3 traded minutes, >= 6 h to close, post-move 5-95c, one per market per 6 h). Both seats are takers at the post-move price, held to settlement, fee 7c*P*(1-P). MR = buy the side the price moved away from; MOM = buy the side it moved toward. Source: github.com/Jon-Becker/prediction-market-analysis (MIT).

## By the price mean reversion would pay (all categories)

| MR buy price | signals | avg move c | MR win % | MR net c/contract | MOM win % | MOM net c/contract |
|---|---|---|---|---|---|---|
| a <20c | 7467 | 16.6 | 16.08 | 3.643 | 83.92 | -5.067 |
| b 20-34c | 7999 | 15.6 | 31.74 | 3.422 | 68.26 | -6.152 |
| c 35-49c | 8441 | 13.6 | 47.36 | 3.829 | 52.64 | -7.21 |
| d 50-64c | 7922 | 13.8 | 60.64 | 2.639 | 39.36 | -6.056 |
| e 65-79c | 6341 | 12.0 | 76.5 | 3.439 | 23.5 | -6.257 |
| f 80c+ | 3609 | 9.9 | 89.36 | 4.129 | 10.64 | -5.966 |

## By category (MR buy price >= 35c, the v2 fence)

| group | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| Crypto | 2378 | 58.75 | 2.238 | 41.25 | -5.409 |
| Entertainment | 2274 | 63.32 | 2.523 | 36.68 | -5.576 |
| Finance | 1150 | 63.04 | 5.56 | 36.96 | -8.732 |
| Media | 1089 | 59.78 | 1.25 | 40.22 | -4.366 |
| Other | 1279 | 65.6 | 5.34 | 34.4 | -8.42 |
| Politics | 4055 | 64.91 | 4.476 | 35.09 | -7.533 |
| Sports | 2937 | 63.81 | 3.906 | 36.19 | -7.004 |
| Weather | 10736 | 65.93 | 3.326 | 34.07 | -6.295 |

## By category, all prices

| group | signals | avg MR price | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|---|
| Crypto | 3454 | 44.5 | 47.83 | 1.932 | 52.17 | -4.814 |
| Entertainment | 3756 | 43.5 | 48.43 | 3.639 | 51.57 | -6.302 |
| Finance | 1764 | 43.8 | 49.43 | 4.239 | 50.57 | -7.083 |
| Media | 1803 | 42.1 | 46.98 | 3.557 | 53.02 | -6.263 |
| Other | 2204 | 42.1 | 48.68 | 5.263 | 51.32 | -7.912 |
| Politics | 6459 | 44.2 | 49.56 | 4.058 | 50.44 | -6.749 |
| Science/Tech | 302 | 41.8 | 42.72 | -0.406 | 57.28 | -2.194 |
| Sports | 4886 | 42.9 | 48.87 | 4.657 | 51.13 | -7.355 |
| Weather | 16744 | 46.2 | 50.46 | 2.958 | 49.54 | -5.611 |

## By move size (MR buy price >= 35c)

| move | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| a 8-11c | 16139 | 64.03 | 1.782 | 35.97 | -4.752 |
| b 12-19c | 7151 | 64.51 | 4.361 | 35.49 | -7.457 |
| c 20-29c | 2040 | 63.68 | 7.769 | 36.32 | -11.05 |
| d 30c+ | 983 | 64.39 | 14.396 | 35.61 | -17.789 |

## Bounce control: signal minutes where takers bought both sides, MR entered at the price a taker actually PAID for that side that minute

| MR buy price | signals | MR win % | MR net at price paid | MR net at last price |
|---|---|---|---|---|
| a <20c | 721 | 15.81 | -3.667 | 3.361 |
| b 20-34c | 811 | 28.11 | -6.306 | -0.123 |
| c 35-49c | 805 | 48.82 | 0.111 | 5.251 |
| d 50-64c | 766 | 61.88 | -1.833 | 4.052 |
| e 65-79c | 707 | 76.24 | -1.069 | 3.232 |
| f 80c+ | 377 | 88.86 | -0.407 | 3.625 |

## By hours to close (MR buy price >= 35c)

| hours to close | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| a 6-12h | 6836 | 64.03 | 2.424 | 35.97 | -5.415 |
| b 12-24h | 9130 | 64.44 | 4.029 | 35.56 | -7.08 |
| c 1-3d | 4519 | 62.93 | 2.187 | 37.07 | -5.253 |
| d >3d | 5828 | 64.76 | 4.582 | 35.24 | -7.661 |

