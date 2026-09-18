# Backtest: move audit (mean reversion vs momentum) on the Becker Kalshi dataset (2026-09-09)

Trades since 2024-10-01; 17,934,707 one-minute candles; 53,346 qualifying moves (>= 6c in 10 min, >= 3 traded minutes, >= 6 h to close, post-move 5-95c, one per market per 6 h). Both seats are takers at the post-move price, held to settlement, fee 7c*P*(1-P). MR = buy the side the price moved away from; MOM = buy the side it moved toward. Source: github.com/Jon-Becker/prediction-market-analysis (MIT).

## By the price mean reversion would pay (all categories)

| MR buy price | signals | avg move c | MR win % | MR net c/contract | MOM win % | MOM net c/contract |
|---|---|---|---|---|---|---|
| a <20c | 9221 | 13.3 | 14.65 | 2.286 | 85.35 | -3.702 |
| b 20-34c | 9480 | 12.8 | 30.42 | 2.046 | 69.58 | -4.78 |
| c 35-49c | 10382 | 11.1 | 46.44 | 2.789 | 53.56 | -6.173 |
| d 50-64c | 9907 | 11.2 | 60.28 | 2.193 | 39.72 | -5.609 |
| e 65-79c | 8172 | 9.8 | 76.14 | 2.911 | 23.86 | -5.718 |
| f 80c+ | 6184 | 7.9 | 89.84 | 3.454 | 10.16 | -5.166 |

## By category (MR buy price >= 35c, the v2 fence)

| group | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| Crypto | 3224 | 60.27 | 1.76 | 39.73 | -4.851 |
| Entertainment | 3011 | 64.43 | 1.568 | 35.57 | -4.523 |
| Finance | 1680 | 63.69 | 4.085 | 36.31 | -7.168 |
| Media | 1376 | 59.81 | 0.275 | 40.19 | -3.337 |
| Other | 1732 | 65.82 | 3.804 | 34.18 | -6.797 |
| Politics | 5434 | 66.16 | 3.95 | 33.84 | -6.917 |
| Sports | 4129 | 65.25 | 3.642 | 34.75 | -6.65 |
| Weather | 13491 | 66.83 | 2.607 | 33.17 | -5.483 |

## By category, all prices

| group | signals | avg MR price | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|---|
| Crypto | 4646 | 45.7 | 48.69 | 1.563 | 51.31 | -4.365 |
| Entertainment | 4835 | 45.4 | 49.0 | 2.329 | 51.0 | -4.938 |
| Finance | 2530 | 45.6 | 50.0 | 3.031 | 50.0 | -5.821 |
| Media | 2166 | 44.2 | 47.51 | 1.992 | 52.49 | -4.716 |
| Other | 2852 | 44.1 | 48.77 | 3.327 | 51.23 | -5.941 |
| Politics | 8383 | 46.2 | 50.64 | 3.061 | 49.36 | -5.722 |
| Science/Tech | 417 | 44.3 | 48.2 | 2.612 | 51.8 | -5.23 |
| Sports | 6592 | 44.9 | 50.12 | 3.907 | 49.88 | -6.569 |
| Weather | 20420 | 48.0 | 51.41 | 2.112 | 48.59 | -4.712 |
| World Events | 303 | 47.5 | 48.51 | -0.333 | 51.49 | -2.451 |

## By move size (MR buy price >= 35c)

| move | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| a 8-11c | 26478 | 65.37 | 1.733 | 34.63 | -4.629 |
| b 12-19c | 5569 | 64.72 | 4.352 | 35.28 | -7.442 |
| c 20-29c | 1724 | 64.1 | 8.098 | 35.9 | -11.377 |
| d 30c+ | 874 | 63.39 | 13.441 | 36.61 | -16.834 |

## Bounce control: signal minutes where takers bought both sides, MR entered at the price a taker actually PAID for that side that minute

| MR buy price | signals | MR win % | MR net at price paid | MR net at last price |
|---|---|---|---|---|
| a <20c | 832 | 12.74 | -5.019 | 0.626 |
| b 20-34c | 882 | 27.1 | -6.571 | -1.281 |
| c 35-49c | 910 | 47.47 | -0.681 | 3.686 |
| d 50-64c | 931 | 62.19 | -0.803 | 4.155 |
| e 65-79c | 838 | 75.06 | -1.755 | 1.717 |
| f 80c+ | 634 | 87.38 | -2.087 | 1.164 |

## By hours to close (MR buy price >= 35c)

| hours to close | signals | MR win % | MR net | MOM win % | MOM net |
|---|---|---|---|---|---|
| a 6-12h | 7794 | 65.26 | 2.101 | 34.74 | -5.004 |
| b 12-24h | 11640 | 65.08 | 2.943 | 34.92 | -5.903 |
| c 1-3d | 6701 | 64.51 | 2.171 | 35.49 | -5.158 |
| d >3d | 8510 | 65.65 | 3.603 | 34.35 | -6.587 |

