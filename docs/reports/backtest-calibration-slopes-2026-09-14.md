# Calibration slopes by domain, Becker Kalshi archive (2026-09-14)

Trades since 2024-10-01; split at 2025-07-01; 63,522,504 trades, 16,677,965,460 contracts; finalized binary markets only; day-clustered by close date; bootstrap 400 resamples of clusters.

Slope 1.0 means the traded price is a calibrated probability. Above 1: outcomes more extreme than prices (prices compressed toward 50c; buying favourites pays before fees). Below 1: prices more extreme than outcomes (buying longshots pays before fees). The band tables say whether either survives the taker fee.

## Calibration slope of outcome on traded YES price (1.0 = calibrated), contract-weighted, day-clustered bootstrap band (10-90%)

| group | half | horizon | day-clusters | contracts | slope | 10% | 90% | reads |
|---|---|---|---|---|---|---|---|---|
| Sports | A select | ALL | 172 | 1,880,643,029 | 1.014 | 0.923 | 1.097 | calibrated within band |
| Sports | A select | a <1h | 120 | 364,540,370 | 0.959 | 0.869 | 1.032 | calibrated within band |
| Sports | A select | b 1-6h | 122 | 754,492,714 | 0.949 | 0.792 | 1.09 | calibrated within band |
| Sports | A select | c 6-24h | 127 | 174,306,509 | 1.175 | 1.0 | 1.323 | COMPRESSED (favourites under-priced) |
| Sports | A select | d 1-3d | 126 | 204,714,519 | 1.121 | 0.992 | 1.234 | calibrated within band |
| Sports | A select | e 3-7d | 105 | 157,118,889 | 1.088 | 0.997 | 1.178 | calibrated within band |
| Sports | A select | f >7d | 107 | 225,470,028 | 1.116 | 0.799 | 1.269 | calibrated within band |
| Sports | B evaluate | ALL | 146 | 10,905,875,057 | 1.000 | 0.971 | 1.027 | calibrated within band |
| Sports | B evaluate | a <1h | 146 | 3,181,435,662 | 1.038 | 1.014 | 1.065 | COMPRESSED (favourites under-priced) |
| Sports | B evaluate | b 1-6h | 146 | 6,048,126,889 | 0.969 | 0.92 | 1.016 | calibrated within band |
| Sports | B evaluate | c 6-24h | 146 | 961,162,642 | 0.976 | 0.921 | 1.027 | calibrated within band |
| Sports | B evaluate | d 1-3d | 144 | 387,323,209 | 0.963 | 0.895 | 1.025 | calibrated within band |
| Sports | B evaluate | e 3-7d | 122 | 227,156,688 | 0.921 | 0.857 | 0.975 | STRETCHED (favourites over-priced) |
| Sports | B evaluate | f >7d | 103 | 100,669,967 | 1.179 | 1.003 | 1.319 | COMPRESSED (favourites under-priced) |
| Politics | A select | ALL | 188 | 1,705,047,156 | 1.116 | 1.069 | 1.171 | COMPRESSED (favourites under-priced) |
| Politics | A select | a <1h | 105 | 9,226,374 | 1.021 | 0.989 | 1.046 | calibrated within band |
| Politics | A select | b 1-6h | 112 | 20,153,781 | 0.929 | 0.817 | 1.004 | calibrated within band |
| Politics | A select | c 6-24h | 130 | 33,333,277 | 1.055 | 1.021 | 1.078 | COMPRESSED (favourites under-priced) |
| Politics | A select | d 1-3d | 132 | 30,103,546 | 1.041 | 1.002 | 1.073 | COMPRESSED (favourites under-priced) |
| Politics | A select | e 3-7d | 120 | 41,515,844 | 1.043 | 1.006 | 1.07 | COMPRESSED (favourites under-priced) |
| Politics | A select | f >7d | 150 | 1,570,714,334 | 1.128 | 1.077 | 1.205 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | ALL | 116 | 490,146,440 | 1.150 | 1.115 | 1.175 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | a <1h | 93 | 13,473,758 | 1.051 | 1.015 | 1.071 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | b 1-6h | 104 | 33,100,866 | 1.067 | 1.027 | 1.094 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | c 6-24h | 112 | 62,397,677 | 1.064 | 1.043 | 1.077 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | d 1-3d | 108 | 102,904,178 | 1.104 | 1.09 | 1.115 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | e 3-7d | 101 | 75,667,065 | 1.137 | 1.111 | 1.191 | COMPRESSED (favourites under-priced) |
| Politics | B evaluate | f >7d | 90 | 202,602,896 | 1.248 | 1.187 | 1.292 | COMPRESSED (favourites under-priced) |
| Crypto | A select | ALL | 272 | 334,188,903 | 0.994 | 0.979 | 1.008 | calibrated within band |
| Crypto | A select | a <1h | 257 | 216,405,686 | 0.987 | 0.975 | 0.999 | STRETCHED (favourites over-priced) |
| Crypto | A select | b 1-6h | 258 | 63,660,276 | 0.974 | 0.925 | 1.032 | calibrated within band |
| Crypto | A select | c 6-24h | 258 | 41,472,284 | 1.003 | 0.918 | 1.066 | calibrated within band |
| Crypto | A select | d 1-3d | 211 | 2,850,925 | 1.127 | 1.017 | 1.208 | COMPRESSED (favourites under-priced) |
| Crypto | A select | e 3-7d | 62 | 3,370,259 | 0.987 | 0.639 | 1.068 | calibrated within band |
| Crypto | A select | f >7d | 50 | 6,429,473 | 1.174 | 0.662 | 1.467 | calibrated within band |
| Crypto | B evaluate | ALL | 146 | 430,524,630 | 1.011 | 0.993 | 1.028 | calibrated within band |
| Crypto | B evaluate | a <1h | 146 | 373,752,466 | 1.005 | 0.995 | 1.017 | calibrated within band |
| Crypto | B evaluate | b 1-6h | 146 | 11,163,750 | 1.053 | 1.001 | 1.103 | COMPRESSED (favourites under-priced) |
| Crypto | B evaluate | c 6-24h | 145 | 9,546,215 | 1.009 | 0.959 | 1.063 | calibrated within band |
| Crypto | B evaluate | d 1-3d | 132 | 3,854,204 | 1.139 | 1.04 | 1.187 | COMPRESSED (favourites under-priced) |
| Crypto | B evaluate | e 3-7d | 42 | 4,059,131 | 1.227 | 0.906 | 1.405 | calibrated within band |
| Crypto | B evaluate | f >7d | 37 | 28,148,864 | 1.061 | 0.423 | 1.199 | calibrated within band |
| Finance | A select | ALL | 248 | 178,554,833 | 1.073 | 1.042 | 1.096 | COMPRESSED (favourites under-priced) |
| Finance | A select | a <1h | 208 | 62,800,515 | 1.028 | 1.01 | 1.048 | COMPRESSED (favourites under-priced) |
| Finance | A select | b 1-6h | 215 | 24,649,296 | 1.063 | 1.033 | 1.091 | COMPRESSED (favourites under-priced) |
| Finance | A select | c 6-24h | 223 | 13,056,874 | 1.035 | 0.958 | 1.092 | calibrated within band |
| Finance | A select | d 1-3d | 157 | 7,775,805 | 0.956 | 0.838 | 1.057 | calibrated within band |
| Finance | A select | e 3-7d | 126 | 12,230,700 | 1.083 | 0.988 | 1.162 | calibrated within band |
| Finance | A select | f >7d | 82 | 58,041,643 | 1.147 | 1.046 | 1.195 | COMPRESSED (favourites under-priced) |
| Finance | B evaluate | ALL | 127 | 141,458,666 | 1.005 | 0.969 | 1.036 | calibrated within band |
| Finance | B evaluate | a <1h | 116 | 65,931,232 | 0.977 | 0.949 | 1.004 | calibrated within band |
| Finance | B evaluate | b 1-6h | 122 | 17,544,838 | 1.016 | 0.956 | 1.084 | calibrated within band |
| Finance | B evaluate | c 6-24h | 124 | 14,483,288 | 0.950 | 0.875 | 1.016 | calibrated within band |
| Finance | B evaluate | d 1-3d | 95 | 9,264,057 | 0.922 | 0.826 | 1.024 | calibrated within band |
| Finance | B evaluate | e 3-7d | 71 | 8,373,130 | 1.045 | 0.957 | 1.107 | calibrated within band |
| Finance | B evaluate | f >7d | 31 | 25,862,121 | 1.100 | 1.02 | 1.152 | COMPRESSED (favourites under-priced) |
| Weather | A select | ALL | 282 | 172,121,190 | 0.959 | 0.943 | 0.977 | STRETCHED (favourites over-priced) |
| Weather | A select | a <1h | 261 | 3,106,311 | 0.993 | 0.97 | 1.016 | calibrated within band |
| Weather | A select | b 1-6h | 274 | 15,240,768 | 0.976 | 0.945 | 1.004 | calibrated within band |
| Weather | A select | c 6-24h | 274 | 126,611,295 | 0.948 | 0.923 | 0.966 | STRETCHED (favourites over-priced) |
| Weather | A select | d 1-3d | 272 | 19,115,573 | 0.980 | 0.945 | 1.017 | calibrated within band |
| Weather | A select | e 3-7d | 37 | 2,767,564 | 1.053 | 0.907 | 1.106 | calibrated within band |
| Weather | A select | f >7d | 39 | 5,279,679 | 1.097 | 0.988 | 1.158 | calibrated within band |
| Weather | B evaluate | ALL | 146 | 80,296,161 | 1.008 | 0.997 | 1.018 | calibrated within band |
| Weather | B evaluate | a <1h | 145 | 658,052 | 1.008 | 0.981 | 1.032 | calibrated within band |
| Weather | B evaluate | b 1-6h | 146 | 5,615,262 | 1.020 | 1.014 | 1.025 | COMPRESSED (favourites under-priced) |
| Weather | B evaluate | c 6-24h | 146 | 63,383,623 | 1.002 | 0.99 | 1.014 | calibrated within band |
| Weather | B evaluate | d 1-3d | 145 | 9,164,930 | 1.096 | 1.053 | 1.139 | COMPRESSED (favourites under-priced) |
| Weather | B evaluate | e 3-7d | 25 | 525,520 | 1.143 | 1.025 | 1.224 | COMPRESSED (favourites under-priced) |
| Weather | B evaluate | f >7d | 24 | 948,774 | 0.843 | 0.659 | 1.041 | calibrated within band |
| Entertainment | A select | ALL | 297 | 95,348,046 | 0.992 | 0.963 | 1.017 | calibrated within band |
| Entertainment | A select | a <1h | 246 | 4,780,586 | 0.961 | 0.903 | 1.014 | calibrated within band |
| Entertainment | A select | b 1-6h | 249 | 9,987,784 | 0.997 | 0.94 | 1.047 | calibrated within band |
| Entertainment | A select | c 6-24h | 255 | 20,421,861 | 0.980 | 0.949 | 1.015 | calibrated within band |
| Entertainment | A select | d 1-3d | 251 | 14,611,462 | 1.043 | 1.01 | 1.072 | COMPRESSED (favourites under-priced) |
| Entertainment | A select | e 3-7d | 146 | 23,640,661 | 0.982 | 0.936 | 1.031 | calibrated within band |
| Entertainment | A select | f >7d | 165 | 21,905,692 | 0.958 | 0.899 | 1.028 | calibrated within band |
| Entertainment | B evaluate | ALL | 141 | 70,663,994 | 1.007 | 0.967 | 1.032 | calibrated within band |
| Entertainment | B evaluate | a <1h | 136 | 4,066,793 | 0.986 | 0.906 | 1.035 | calibrated within band |
| Entertainment | B evaluate | b 1-6h | 139 | 6,670,844 | 0.995 | 0.916 | 1.086 | calibrated within band |
| Entertainment | B evaluate | c 6-24h | 141 | 18,596,690 | 0.973 | 0.919 | 1.02 | calibrated within band |
| Entertainment | B evaluate | d 1-3d | 135 | 12,879,621 | 0.999 | 0.955 | 1.025 | calibrated within band |
| Entertainment | B evaluate | e 3-7d | 90 | 15,993,466 | 1.063 | 1.023 | 1.081 | COMPRESSED (favourites under-priced) |
| Entertainment | B evaluate | f >7d | 83 | 12,456,580 | 0.966 | 0.861 | 1.08 | calibrated within band |
| Other | A select | ALL | 281 | 55,300,037 | 1.036 | 1.007 | 1.062 | COMPRESSED (favourites under-priced) |
| Other | A select | a <1h | 126 | 2,748,874 | 1.038 | 1.013 | 1.061 | COMPRESSED (favourites under-priced) |
| Other | A select | b 1-6h | 158 | 5,393,497 | 0.959 | 0.908 | 1.022 | calibrated within band |
| Other | A select | c 6-24h | 180 | 6,977,690 | 0.993 | 0.96 | 1.026 | calibrated within band |
| Other | A select | d 1-3d | 193 | 5,159,432 | 1.028 | 0.983 | 1.074 | calibrated within band |
| Other | A select | e 3-7d | 191 | 5,284,024 | 1.111 | 1.08 | 1.139 | COMPRESSED (favourites under-priced) |
| Other | A select | f >7d | 253 | 29,736,520 | 1.067 | 1.016 | 1.106 | COMPRESSED (favourites under-priced) |
| Other | B evaluate | ALL | 137 | 34,155,954 | 1.023 | 0.99 | 1.054 | calibrated within band |
| Other | B evaluate | a <1h | 96 | 3,034,539 | 1.017 | 0.985 | 1.049 | calibrated within band |
| Other | B evaluate | b 1-6h | 120 | 3,994,161 | 1.074 | 1.034 | 1.104 | COMPRESSED (favourites under-priced) |
| Other | B evaluate | c 6-24h | 131 | 4,083,665 | 1.006 | 0.964 | 1.042 | calibrated within band |
| Other | B evaluate | d 1-3d | 128 | 5,587,946 | 1.005 | 0.952 | 1.051 | calibrated within band |
| Other | B evaluate | e 3-7d | 125 | 6,508,034 | 0.979 | 0.867 | 1.056 | calibrated within band |
| Other | B evaluate | f >7d | 119 | 10,947,609 | 1.048 | 0.987 | 1.095 | calibrated within band |
| World Events | A select | ALL | 13 | 17,463,781 | 0.235 | 0.087 | 0.859 | STRETCHED (favourites over-priced) |
| World Events | A select | a <1h | 5 | 878,786 | 0.668 | 0.668 | 1.043 | calibrated within band |
| World Events | A select | b 1-6h | 3 | 657,355 | 0.420 | None | None |  |
| World Events | A select | c 6-24h | 7 | 1,411,518 | 0.822 | 0.751 | 1.035 | calibrated within band |
| World Events | A select | d 1-3d | 7 | 3,068,782 | 0.868 | 0.757 | 1.096 | calibrated within band |
| World Events | A select | e 3-7d | 9 | 1,883,279 | 0.650 | 0.415 | 1.021 | calibrated within band |
| World Events | A select | f >7d | 13 | 9,564,061 | 0.095 | 0.005 | 1.044 | calibrated within band |
| World Events | B evaluate | ALL | 19 | 19,048,397 | 1.140 | 0.485 | 1.306 | calibrated within band |
| World Events | B evaluate | a <1h | 9 | 976,621 | 0.985 | 0.866 | 1.073 | calibrated within band |
| World Events | B evaluate | b 1-6h | 11 | 1,928,100 | 0.997 | 0.662 | 1.156 | calibrated within band |
| World Events | B evaluate | c 6-24h | 16 | 5,750,475 | 1.153 | 0.093 | 1.403 | calibrated within band |
| World Events | B evaluate | d 1-3d | 15 | 2,921,781 | 1.112 | 0.338 | 1.185 | calibrated within band |
| World Events | B evaluate | e 3-7d | 17 | 1,822,278 | 1.122 | 0.316 | 1.201 | calibrated within band |
| World Events | B evaluate | f >7d | 19 | 5,649,142 | 1.880 | 0.585 | 2.083 | calibrated within band |
| Media | A select | ALL | 121 | 9,662,826 | 1.038 | 0.999 | 1.067 | calibrated within band |
| Media | A select | a <1h | 94 | 345,694 | 0.996 | 0.956 | 1.045 | calibrated within band |
| Media | A select | b 1-6h | 105 | 1,898,379 | 0.987 | 0.949 | 1.015 | calibrated within band |
| Media | A select | c 6-24h | 114 | 1,879,644 | 1.022 | 0.987 | 1.051 | calibrated within band |
| Media | A select | d 1-3d | 112 | 1,896,850 | 1.065 | 0.986 | 1.142 | calibrated within band |
| Media | A select | e 3-7d | 107 | 2,292,269 | 1.088 | 0.993 | 1.162 | calibrated within band |
| Media | A select | f >7d | 29 | 1,349,990 | 0.680 | 0.504 | 0.905 | STRETCHED (favourites over-priced) |
| Media | B evaluate | ALL | 96 | 19,824,566 | 1.013 | 0.986 | 1.034 | calibrated within band |
| Media | B evaluate | a <1h | 89 | 1,028,725 | 1.012 | 0.994 | 1.031 | calibrated within band |
| Media | B evaluate | b 1-6h | 92 | 4,261,393 | 0.977 | 0.937 | 1.011 | calibrated within band |
| Media | B evaluate | c 6-24h | 96 | 9,553,280 | 1.018 | 0.999 | 1.032 | calibrated within band |
| Media | B evaluate | d 1-3d | 92 | 2,711,809 | 1.087 | 0.964 | 1.157 | calibrated within band |
| Media | B evaluate | e 3-7d | 79 | 1,382,722 | 1.044 | 0.938 | 1.128 | calibrated within band |
| Media | B evaluate | f >7d | 41 | 886,637 | 0.994 | 0.876 | 1.09 | calibrated within band |
| Esports | A select | ALL | 1 | 27,652 | -0.881 | None | None |  |
| Esports | A select | f >7d | 1 | 27,652 | -0.881 | None | None |  |
| Esports | B evaluate | ALL | 32 | 20,804,602 | 0.993 | 0.728 | 1.169 | calibrated within band |
| Esports | B evaluate | a <1h | 31 | 863,262 | 1.206 | 1.098 | 1.263 | COMPRESSED (favourites under-priced) |
| Esports | B evaluate | b 1-6h | 32 | 6,527,530 | 0.951 | 0.643 | 1.25 | calibrated within band |
| Esports | B evaluate | c 6-24h | 31 | 9,622,557 | 1.025 | 0.787 | 1.192 | calibrated within band |
| Esports | B evaluate | d 1-3d | 19 | 1,593,148 | 1.137 | 0.586 | 1.513 | calibrated within band |
| Esports | B evaluate | e 3-7d | 2 | 842,267 | 3.490 | None | None |  |
| Esports | B evaluate | f >7d | 1 | 1,355,838 | -0.045 | None | None |  |
| Science/Tech | A select | ALL | 78 | 9,500,436 | 0.969 | 0.855 | 1.065 | calibrated within band |
| Science/Tech | A select | a <1h | 26 | 43,602 | 1.098 | 0.99 | 1.12 | calibrated within band |
| Science/Tech | A select | b 1-6h | 33 | 246,699 | 0.848 | 0.567 | 1.036 | calibrated within band |
| Science/Tech | A select | c 6-24h | 44 | 708,317 | 0.942 | 0.759 | 1.1 | calibrated within band |
| Science/Tech | A select | d 1-3d | 52 | 1,187,092 | 1.036 | 0.928 | 1.094 | calibrated within band |
| Science/Tech | A select | e 3-7d | 48 | 1,840,055 | 1.013 | 0.868 | 1.086 | calibrated within band |
| Science/Tech | A select | f >7d | 65 | 5,474,671 | 0.932 | 0.714 | 1.159 | calibrated within band |
| Science/Tech | B evaluate | ALL | 45 | 7,309,104 | 1.153 | 0.981 | 1.195 | calibrated within band |
| Science/Tech | B evaluate | a <1h | 25 | 598,858 | 0.893 | 0.585 | 1.03 | calibrated within band |
| Science/Tech | B evaluate | b 1-6h | 25 | 354,802 | 1.050 | 0.815 | 1.154 | calibrated within band |
| Science/Tech | B evaluate | c 6-24h | 35 | 1,902,396 | 1.202 | 0.881 | 1.246 | calibrated within band |
| Science/Tech | B evaluate | d 1-3d | 40 | 1,356,100 | 0.938 | 0.539 | 1.166 | calibrated within band |
| Science/Tech | B evaluate | e 3-7d | 38 | 704,190 | 1.181 | 1.014 | 1.257 | COMPRESSED (favourites under-priced) |
| Science/Tech | B evaluate | f >7d | 35 | 2,392,758 | 1.272 | 1.172 | 1.326 | COMPRESSED (favourites under-priced) |


## Net excess return of buying the side at its traker price, cents per contract after the taker fee, by group, half and 10c band of the price paid (** = day-clustered 80% lower bound above zero)

| group | half | price paid | day-clusters | contracts | taker net c | +-1.28 SE | maker net c (no fee) | +-1.28 SE |
|---|---|---|---|---|---|---|---|---|
| Sports | A select | 05-14 | 157 | 229,302,888 | -0.23 | 2.97 | -0.34 | 2.98 |
| Sports | A select | 15-24 | 161 | 195,144,374 | -4.40 | 5.01 | +3.31 | 5.01 |
| Sports | A select | 25-34 | 158 | 197,834,117 | -4.97 | 6.21 | +3.52 | 6.22 |
| Sports | A select | 35-44 | 156 | 147,416,452 | -5.67 | 4.69 | +4.00 | 4.69 |
| Sports | A select | 45-54 | 149 | 172,749,760 | -1.68 | 1.33 | -0.06 | 1.33 |
| Sports | A select | 55-64 | 151 | 156,564,887 | +0.03 | 4.38 | -1.71 | 4.38 |
| Sports | A select | 65-74 | 156 | 171,421,825 | -4.07 | 7.62 | +2.59 | 7.62 |
| Sports | A select | 75-84 | 158 | 174,648,170 | +3.05 | 4.16 | -4.19 | 4.17 |
| Sports | A select | 85-94 | 159 | 160,643,275 | -3.22 | 4.13 | +2.57 | 4.13 |
| Sports | A select | 95-104 | 159 | 91,229,280 | -2.62 | 2.19 | +2.42 | 2.19 |
| Sports | B evaluate | 05-14 | 146 | 1,009,867,400 | -2.67 | 0.67 | +2.08 | 0.67 |
| Sports | B evaluate | 15-24 | 146 | 937,577,195 | -0.90 | 2.23 | -0.19 | 2.23 |
| Sports | B evaluate | 25-34 | 146 | 1,020,378,179 | -0.54 | 2.24 | -0.91 | 2.24 |
| Sports | B evaluate | 35-44 | 146 | 1,173,891,373 | -2.58 | 1.80 | +0.91 | 1.80 |
| Sports | B evaluate | 45-54 | 146 | 1,387,884,910 | -2.57 | 0.78 | +0.83 | 0.78 |
| Sports | B evaluate | 55-64 | 146 | 1,293,250,466 | -3.47 | 2.03 | +1.79 | 2.03 |
| Sports | B evaluate | 65-74 | 146 | 1,009,774,286 | -3.97 | 2.31 | +2.49 | 2.31 |
| Sports | B evaluate | 75-84 | 146 | 903,965,126 | -1.95 | 2.38 | +0.82 | 2.38 |
| Sports | B evaluate | 85-94 | 146 | 944,780,749 | -0.10 | 0.98 | -0.55 | 0.98 |
| Sports | B evaluate | 95-104 | 146 | 501,977,906 | -0.17 | 0.53 | -0.03 | 0.53 |
| Politics | A select | 05-14 | 170 | 216,403,398 | -5.43 | 1.35 | +4.90 | 1.34 |
| Politics | A select | 15-24 | 167 | 86,623,697 | -4.68 | 4.21 | +3.61 | 4.21 |
| Politics | A select | 25-34 | 169 | 67,791,541 | -1.20 | 6.37 | -0.25 | 6.37 |
| Politics | A select | 35-44 | 167 | 146,922,713 | -29.99 | 11.21 | +28.31 | 11.20 |
| Politics | A select | 45-54 | 163 | 109,903,458 | -13.68 | 5.44 | +11.94 | 5.44 |
| Politics | A select | 55-64 | 157 | 164,484,151 | +29.05 ** | 10.07 | -30.74 | 10.08 |
| Politics | A select | 65-74 | 169 | 57,105,339 | +4.65 | 5.78 | -6.14 | 5.78 |
| Politics | A select | 75-84 | 172 | 58,898,850 | +0.99 | 4.16 | -2.12 | 4.15 |
| Politics | A select | 85-94 | 175 | 107,361,922 | +3.60 ** | 1.34 | -4.21 | 1.35 |
| Politics | A select | 95-104 | 171 | 337,189,213 | +1.40 ** | 0.11 | -1.53 | 0.11 |
| Politics | B evaluate | 05-14 | 112 | 113,359,206 | -8.76 | 0.82 | +8.21 | 0.78 |
| Politics | B evaluate | 15-24 | 113 | 42,183,439 | -17.48 | 1.44 | +16.43 | 1.45 |
| Politics | B evaluate | 25-34 | 113 | 13,986,700 | -21.36 | 2.35 | +19.92 | 2.35 |
| Politics | B evaluate | 35-44 | 110 | 8,754,332 | -13.77 | 3.37 | +12.11 | 3.37 |
| Politics | B evaluate | 45-54 | 109 | 7,612,366 | -2.22 | 1.38 | +0.48 | 1.38 |
| Politics | B evaluate | 55-64 | 108 | 7,814,186 | -2.80 | 3.01 | +1.12 | 3.01 |
| Politics | B evaluate | 65-74 | 111 | 10,383,173 | +11.17 ** | 2.97 | -12.63 | 2.97 |
| Politics | B evaluate | 75-84 | 114 | 24,141,664 | +15.56 ** | 1.47 | -16.66 | 1.46 |
| Politics | B evaluate | 85-94 | 116 | 61,443,322 | +8.16 ** | 0.58 | -8.76 | 0.59 |
| Politics | B evaluate | 95-104 | 116 | 65,885,237 | +1.92 ** | 0.32 | -2.08 | 0.34 |
| Crypto | A select | 05-14 | 266 | 39,399,047 | -2.21 | 0.45 | +1.62 | 0.45 |
| Crypto | A select | 15-24 | 268 | 31,884,537 | -2.75 | 0.57 | +1.67 | 0.57 |
| Crypto | A select | 25-34 | 268 | 27,230,030 | -4.46 | 0.68 | +3.02 | 0.68 |
| Crypto | A select | 35-44 | 269 | 27,114,084 | -5.00 | 0.85 | +3.33 | 0.85 |
| Crypto | A select | 45-54 | 269 | 31,533,113 | -3.88 | 0.58 | +2.13 | 0.58 |
| Crypto | A select | 55-64 | 267 | 29,444,738 | -2.02 | 0.98 | +0.34 | 0.98 |
| Crypto | A select | 65-74 | 267 | 28,709,032 | -1.21 | 0.93 | -0.27 | 0.93 |
| Crypto | A select | 75-84 | 270 | 31,675,928 | -1.13 | 0.67 | +0.00 | 0.67 |
| Crypto | A select | 85-94 | 268 | 37,544,387 | -1.40 | 0.54 | +0.75 | 0.54 |
| Crypto | A select | 95-104 | 266 | 35,895,914 | -2.07 | 0.44 | +1.90 | 0.44 |
| Crypto | B evaluate | 05-14 | 146 | 46,572,208 | -1.42 | 0.58 | +0.83 | 0.58 |
| Crypto | B evaluate | 15-24 | 146 | 43,108,095 | -2.51 | 0.80 | +1.42 | 0.80 |
| Crypto | B evaluate | 25-34 | 146 | 38,611,403 | -1.38 | 1.22 | -0.06 | 1.22 |
| Crypto | B evaluate | 35-44 | 146 | 35,776,062 | -2.62 | 1.20 | +0.95 | 1.20 |
| Crypto | B evaluate | 45-54 | 146 | 37,269,152 | -1.97 | 0.89 | +0.23 | 0.89 |
| Crypto | B evaluate | 55-64 | 146 | 37,469,428 | -2.63 | 1.27 | +0.95 | 1.27 |
| Crypto | B evaluate | 65-74 | 146 | 39,023,645 | -2.24 | 1.37 | +0.76 | 1.37 |
| Crypto | B evaluate | 75-84 | 146 | 45,433,621 | -0.90 | 1.04 | -0.24 | 1.04 |
| Crypto | B evaluate | 85-94 | 146 | 52,834,596 | -0.63 | 0.67 | -0.01 | 0.68 |
| Crypto | B evaluate | 95-104 | 146 | 38,116,575 | -0.69 | 0.37 | +0.49 | 0.37 |
| Finance | A select | 05-14 | 243 | 23,157,256 | -4.20 | 0.80 | +3.64 | 0.80 |
| Finance | A select | 15-24 | 240 | 15,517,955 | -5.78 | 2.15 | +4.69 | 2.15 |
| Finance | A select | 25-34 | 241 | 13,197,722 | -8.69 | 2.00 | +7.24 | 2.00 |
| Finance | A select | 35-44 | 232 | 13,017,623 | -2.52 | 2.84 | +0.85 | 2.84 |
| Finance | A select | 45-54 | 231 | 14,557,724 | -3.29 | 1.43 | +1.55 | 1.43 |
| Finance | A select | 55-64 | 231 | 15,199,791 | -5.37 | 3.42 | +3.69 | 3.41 |
| Finance | A select | 65-74 | 236 | 14,617,977 | +0.27 | 2.10 | -1.75 | 2.10 |
| Finance | A select | 75-84 | 240 | 18,354,532 | +4.01 ** | 2.13 | -5.15 | 2.13 |
| Finance | A select | 85-94 | 241 | 20,028,801 | +2.43 ** | 1.53 | -3.08 | 1.53 |
| Finance | A select | 95-104 | 242 | 15,774,384 | -0.44 | 0.79 | +0.25 | 0.79 |
| Finance | B evaluate | 05-14 | 126 | 14,634,741 | -2.80 | 1.49 | +2.24 | 1.49 |
| Finance | B evaluate | 15-24 | 127 | 10,957,329 | -5.82 | 2.51 | +4.74 | 2.51 |
| Finance | B evaluate | 25-34 | 124 | 10,626,598 | -1.87 | 2.72 | +0.42 | 2.72 |
| Finance | B evaluate | 35-44 | 125 | 11,126,125 | -0.77 | 3.19 | -0.90 | 3.19 |
| Finance | B evaluate | 45-54 | 120 | 16,289,975 | -2.15 | 2.16 | +0.41 | 2.16 |
| Finance | B evaluate | 55-64 | 118 | 12,685,615 | -4.39 | 3.19 | +2.71 | 3.19 |
| Finance | B evaluate | 65-74 | 120 | 12,450,187 | -1.25 | 2.93 | -0.23 | 2.93 |
| Finance | B evaluate | 75-84 | 126 | 14,725,205 | -1.53 | 3.24 | +0.40 | 3.24 |
| Finance | B evaluate | 85-94 | 127 | 16,965,343 | -0.09 | 2.21 | -0.55 | 2.21 |
| Finance | B evaluate | 95-104 | 127 | 10,481,625 | -1.65 | 1.76 | +1.46 | 1.76 |
| Weather | A select | 05-14 | 281 | 15,707,657 | -0.63 | 0.77 | +0.07 | 0.77 |
| Weather | A select | 15-24 | 280 | 10,042,806 | -0.84 | 1.12 | -0.24 | 1.12 |
| Weather | A select | 25-34 | 279 | 9,051,086 | -1.39 | 1.54 | -0.05 | 1.54 |
| Weather | A select | 35-44 | 279 | 8,363,215 | -2.32 | 1.11 | +0.66 | 1.11 |
| Weather | A select | 45-54 | 278 | 7,590,386 | -3.12 | 0.86 | +1.38 | 0.86 |
| Weather | A select | 55-64 | 278 | 7,497,210 | -3.34 | 0.88 | +1.66 | 0.88 |
| Weather | A select | 65-74 | 279 | 8,783,424 | -6.12 | 1.44 | +4.64 | 1.44 |
| Weather | A select | 75-84 | 280 | 10,538,784 | -5.54 | 1.39 | +4.41 | 1.39 |
| Weather | A select | 85-94 | 281 | 15,185,206 | -4.64 | 1.12 | +4.01 | 1.12 |
| Weather | A select | 95-104 | 281 | 27,781,319 | -1.46 | 0.42 | +1.31 | 0.42 |
| Weather | B evaluate | 05-14 | 146 | 6,635,652 | -3.43 | 0.82 | +2.88 | 0.82 |
| Weather | B evaluate | 15-24 | 146 | 4,174,289 | -3.48 | 1.16 | +2.40 | 1.16 |
| Weather | B evaluate | 25-34 | 146 | 3,842,766 | -2.03 | 1.25 | +0.58 | 1.25 |
| Weather | B evaluate | 35-44 | 146 | 4,247,745 | -0.87 | 1.06 | -0.80 | 1.06 |
| Weather | B evaluate | 45-54 | 146 | 4,227,233 | -1.36 | 0.73 | -0.39 | 0.73 |
| Weather | B evaluate | 55-64 | 146 | 3,795,580 | -3.93 | 1.02 | +2.24 | 1.02 |
| Weather | B evaluate | 65-74 | 146 | 3,734,423 | -3.79 | 1.21 | +2.31 | 1.21 |
| Weather | B evaluate | 75-84 | 146 | 3,957,582 | -3.19 | 1.17 | +2.05 | 1.17 |
| Weather | B evaluate | 85-94 | 146 | 5,397,187 | -1.26 | 0.79 | +0.63 | 0.79 |
| Weather | B evaluate | 95-104 | 146 | 8,460,088 | -0.24 | 0.36 | +0.09 | 0.36 |
| Entertainment | A select | 05-14 | 279 | 12,033,986 | -2.76 | 1.82 | +2.21 | 1.82 |
| Entertainment | A select | 15-24 | 270 | 6,941,314 | -0.55 | 3.06 | -0.53 | 3.05 |
| Entertainment | A select | 25-34 | 253 | 5,729,094 | +0.03 | 3.06 | -1.48 | 3.06 |
| Entertainment | A select | 35-44 | 248 | 5,254,833 | -2.14 | 2.13 | +0.47 | 2.13 |
| Entertainment | A select | 45-54 | 248 | 5,115,392 | -2.54 | 1.76 | +0.80 | 1.76 |
| Entertainment | A select | 55-64 | 235 | 5,392,483 | -2.07 | 2.06 | +0.39 | 2.06 |
| Entertainment | A select | 65-74 | 241 | 5,792,596 | -4.86 | 2.97 | +3.38 | 2.97 |
| Entertainment | A select | 75-84 | 261 | 6,287,289 | -1.77 | 2.31 | +0.64 | 2.31 |
| Entertainment | A select | 85-94 | 275 | 9,661,890 | -3.14 | 2.13 | +2.51 | 2.13 |
| Entertainment | A select | 95-104 | 286 | 15,215,065 | -0.50 | 0.67 | +0.35 | 0.67 |
| Entertainment | B evaluate | 05-14 | 139 | 9,470,245 | -3.33 | 2.37 | +2.80 | 2.37 |
| Entertainment | B evaluate | 15-24 | 135 | 3,931,233 | -2.96 | 3.86 | +1.88 | 3.86 |
| Entertainment | B evaluate | 25-34 | 132 | 3,015,713 | +0.61 | 7.86 | -2.07 | 7.87 |
| Entertainment | B evaluate | 35-44 | 130 | 2,964,084 | +6.78 | 8.64 | -8.45 | 8.64 |
| Entertainment | B evaluate | 45-54 | 127 | 2,876,518 | -3.34 | 1.51 | +1.60 | 1.51 |
| Entertainment | B evaluate | 55-64 | 127 | 3,486,583 | -14.34 | 10.10 | +12.66 | 10.10 |
| Entertainment | B evaluate | 65-74 | 129 | 3,217,157 | -12.55 | 12.35 | +11.07 | 12.34 |
| Entertainment | B evaluate | 75-84 | 137 | 3,182,183 | -1.28 | 2.69 | +0.14 | 2.69 |
| Entertainment | B evaluate | 85-94 | 140 | 4,624,322 | -2.63 | 2.72 | +2.00 | 2.72 |
| Entertainment | B evaluate | 95-104 | 139 | 8,507,964 | -1.02 | 1.34 | +0.87 | 1.34 |
| Other | A select | 05-14 | 234 | 7,452,150 | -3.66 | 1.30 | +3.10 | 1.30 |
| Other | A select | 15-24 | 239 | 4,568,807 | -3.15 | 2.57 | +2.07 | 2.57 |
| Other | A select | 25-34 | 240 | 3,870,541 | -1.89 | 3.16 | +0.45 | 3.16 |
| Other | A select | 35-44 | 243 | 3,377,920 | -4.87 | 3.32 | +3.20 | 3.32 |
| Other | A select | 45-54 | 227 | 3,243,381 | -3.63 | 2.77 | +1.89 | 2.77 |
| Other | A select | 55-64 | 235 | 3,339,154 | +1.58 | 3.58 | -3.26 | 3.58 |
| Other | A select | 65-74 | 241 | 3,563,142 | -0.66 | 2.70 | -0.82 | 2.70 |
| Other | A select | 75-84 | 241 | 3,750,433 | -2.03 | 2.48 | +0.89 | 2.48 |
| Other | A select | 85-94 | 252 | 5,091,687 | +0.35 | 1.93 | -0.98 | 1.93 |
| Other | A select | 95-104 | 243 | 8,778,988 | +0.15 | 0.49 | -0.30 | 0.49 |
| Other | B evaluate | 05-14 | 129 | 4,167,752 | -3.40 | 1.70 | +2.84 | 1.70 |
| Other | B evaluate | 15-24 | 127 | 2,808,511 | -1.87 | 3.70 | +0.79 | 3.70 |
| Other | B evaluate | 25-34 | 126 | 2,343,550 | -2.03 | 4.19 | +0.59 | 4.20 |
| Other | B evaluate | 35-44 | 126 | 2,067,334 | -0.62 | 5.25 | -1.05 | 5.25 |
| Other | B evaluate | 45-54 | 119 | 2,061,971 | +0.82 | 4.30 | -2.56 | 4.30 |
| Other | B evaluate | 55-64 | 123 | 1,882,818 | -4.23 | 4.39 | +2.55 | 4.39 |
| Other | B evaluate | 65-74 | 127 | 2,097,538 | -3.79 | 4.59 | +2.31 | 4.59 |
| Other | B evaluate | 75-84 | 128 | 2,233,045 | -3.59 | 4.76 | +2.46 | 4.76 |
| Other | B evaluate | 85-94 | 136 | 2,993,310 | -0.18 | 1.94 | -0.44 | 1.93 |
| Other | B evaluate | 95-104 | 134 | 5,602,010 | +0.59 ** | 0.36 | -0.75 | 0.36 |
| World Events | A select | 05-14 | 12 | 3,505,396 | -2.78 | 9.10 | +2.22 | 9.11 |
| World Events | A select | 15-24 | 9 | 1,379,550 | -7.46 | 17.04 | +6.34 | 17.02 |
| World Events | A select | 25-34 | 9 | 1,251,716 | -13.14 | 13.33 | +11.71 | 13.35 |
| World Events | A select | 35-44 | 9 | 694,574 | +11.11 ** | 2.77 | -12.77 | 2.77 |
| World Events | A select | 45-54 | 10 | 617,452 | +4.54 ** | 2.85 | -6.28 | 2.85 |
| World Events | A select | 55-64 | 9 | 663,408 | -19.41 | 3.59 | +17.72 | 3.58 |
| World Events | A select | 65-74 | 9 | 757,686 | -11.65 | 2.40 | +10.17 | 2.39 |
| World Events | A select | 75-84 | 9 | 630,707 | -8.14 | 16.33 | +6.99 | 16.34 |
| World Events | A select | 85-94 | 10 | 1,467,663 | -9.69 | 18.66 | +9.11 | 18.63 |
| World Events | A select | 95-104 | 10 | 1,818,882 | -5.47 | 3.08 | +5.33 | 3.08 |
| World Events | B evaluate | 05-14 | 19 | 5,417,954 | -7.23 | 1.35 | +6.71 | 1.36 |
| World Events | B evaluate | 15-24 | 17 | 1,214,750 | -10.41 | 6.58 | +9.40 | 6.61 |
| World Events | B evaluate | 25-34 | 18 | 507,161 | -1.51 | 15.36 | +0.05 | 15.36 |
| World Events | B evaluate | 35-44 | 14 | 648,797 | -6.57 | 7.79 | +4.91 | 7.79 |
| World Events | B evaluate | 45-54 | 14 | 500,889 | -0.91 | 5.19 | -0.83 | 5.19 |
| World Events | B evaluate | 55-64 | 14 | 433,475 | -2.61 | 4.71 | +0.93 | 4.71 |
| World Events | B evaluate | 65-74 | 14 | 648,506 | -22.17 | 24.01 | +20.67 | 24.01 |
| World Events | B evaluate | 75-84 | 18 | 549,240 | -10.41 | 6.56 | +9.27 | 6.55 |
| World Events | B evaluate | 85-94 | 17 | 1,757,101 | +5.53 ** | 3.12 | -6.13 | 3.12 |
| World Events | B evaluate | 95-104 | 19 | 2,413,758 | +2.59 ** | 0.66 | -2.80 | 0.69 |
| Media | A select | 05-14 | 116 | 1,032,882 | -4.59 | 1.72 | +4.02 | 1.72 |
| Media | A select | 15-24 | 117 | 805,168 | -7.27 | 4.10 | +6.18 | 4.10 |
| Media | A select | 25-34 | 117 | 727,536 | -10.63 | 5.43 | +9.19 | 5.43 |
| Media | A select | 35-44 | 119 | 593,766 | -13.73 | 5.68 | +12.07 | 5.68 |
| Media | A select | 45-54 | 120 | 618,012 | -14.87 | 5.01 | +13.13 | 5.02 |
| Media | A select | 55-64 | 118 | 504,999 | +3.66 | 4.15 | -5.34 | 4.15 |
| Media | A select | 65-74 | 115 | 634,761 | +0.20 | 4.87 | -1.68 | 4.87 |
| Media | A select | 75-84 | 117 | 761,384 | +2.31 | 4.51 | -3.44 | 4.51 |
| Media | A select | 85-94 | 117 | 926,486 | -0.42 | 2.44 | -0.22 | 2.44 |
| Media | A select | 95-104 | 119 | 1,747,722 | -0.66 | 0.71 | +0.51 | 0.72 |
| Media | B evaluate | 05-14 | 94 | 1,718,662 | -6.38 | 1.10 | +5.82 | 1.10 |
| Media | B evaluate | 15-24 | 95 | 1,034,516 | -6.11 | 2.00 | +5.03 | 2.00 |
| Media | B evaluate | 25-34 | 95 | 998,202 | -2.56 | 2.78 | +1.10 | 2.78 |
| Media | B evaluate | 35-44 | 95 | 1,120,916 | -3.91 | 2.12 | +2.24 | 2.12 |
| Media | B evaluate | 45-54 | 93 | 1,188,904 | -3.37 | 2.49 | +1.63 | 2.49 |
| Media | B evaluate | 55-64 | 94 | 1,122,426 | -12.28 | 2.28 | +10.60 | 2.28 |
| Media | B evaluate | 65-74 | 95 | 1,075,642 | -9.16 | 3.07 | +7.67 | 3.07 |
| Media | B evaluate | 75-84 | 95 | 944,421 | -5.31 | 2.83 | +4.17 | 2.83 |
| Media | B evaluate | 85-94 | 95 | 1,126,465 | -1.92 | 2.08 | +1.28 | 2.07 |
| Media | B evaluate | 95-104 | 96 | 2,335,364 | -0.71 | 0.60 | +0.58 | 0.60 |
| Esports | B evaluate | 05-14 | 32 | 2,529,223 | +14.97 | 15.05 | -15.58 | 15.09 |
| Esports | B evaluate | 15-24 | 32 | 1,289,266 | -3.36 | 7.26 | +2.27 | 7.27 |
| Esports | B evaluate | 25-34 | 32 | 1,483,976 | -3.50 | 13.05 | +2.08 | 13.06 |
| Esports | B evaluate | 35-44 | 32 | 2,220,902 | -15.47 | 3.46 | +13.82 | 3.46 |
| Esports | B evaluate | 45-54 | 30 | 2,098,283 | +3.01 | 6.29 | -4.75 | 6.29 |
| Esports | B evaluate | 55-64 | 31 | 2,149,712 | +11.96 ** | 3.66 | -13.62 | 3.66 |
| Esports | B evaluate | 65-74 | 31 | 2,382,640 | +15.34 ** | 5.78 | -16.86 | 5.80 |
| Esports | B evaluate | 75-84 | 31 | 1,433,714 | +7.40 | 7.74 | -8.57 | 7.77 |
| Esports | B evaluate | 85-94 | 32 | 1,190,977 | -26.74 | 24.00 | +26.05 | 23.98 |
| Esports | B evaluate | 95-104 | 32 | 765,776 | +0.23 | 1.03 | -0.40 | 1.04 |
| Science/Tech | A select | 05-14 | 66 | 1,233,667 | -1.56 | 4.79 | +1.02 | 4.78 |
| Science/Tech | A select | 15-24 | 65 | 681,239 | -6.99 | 3.45 | +5.91 | 3.45 |
| Science/Tech | A select | 25-34 | 60 | 566,014 | -8.71 | 10.68 | +7.25 | 10.68 |
| Science/Tech | A select | 35-44 | 57 | 609,935 | -7.23 | 7.77 | +5.57 | 7.77 |
| Science/Tech | A select | 45-54 | 54 | 790,711 | +4.70 ** | 4.14 | -6.45 | 4.14 |
| Science/Tech | A select | 55-64 | 57 | 608,827 | -0.99 | 6.38 | -0.69 | 6.38 |
| Science/Tech | A select | 65-74 | 59 | 648,983 | +3.29 | 7.38 | -4.77 | 7.38 |
| Science/Tech | A select | 75-84 | 65 | 654,366 | +5.57 ** | 4.16 | -6.71 | 4.15 |
| Science/Tech | A select | 85-94 | 69 | 844,686 | -1.11 | 6.76 | +0.50 | 6.77 |
| Science/Tech | A select | 95-104 | 69 | 1,593,718 | -0.55 | 1.67 | +0.40 | 1.67 |
| Science/Tech | B evaluate | 05-14 | 40 | 747,929 | -7.88 | 0.97 | +7.36 | 0.97 |
| Science/Tech | B evaluate | 15-24 | 40 | 481,523 | -14.74 | 5.23 | +13.61 | 5.22 |
| Science/Tech | B evaluate | 25-34 | 38 | 735,744 | -19.26 | 9.31 | +17.82 | 9.31 |
| Science/Tech | B evaluate | 35-44 | 34 | 500,087 | -21.17 | 9.29 | +19.51 | 9.29 |
| Science/Tech | B evaluate | 45-54 | 33 | 686,174 | -5.47 | 1.52 | +3.73 | 1.52 |
| Science/Tech | B evaluate | 55-64 | 34 | 568,625 | +10.30 ** | 7.55 | -11.99 | 7.55 |
| Science/Tech | B evaluate | 65-74 | 36 | 645,101 | +18.16 ** | 7.67 | -19.63 | 7.68 |
| Science/Tech | B evaluate | 75-84 | 40 | 565,575 | +5.05 | 9.45 | -6.19 | 9.45 |
| Science/Tech | B evaluate | 85-94 | 41 | 443,748 | +2.25 | 6.24 | -2.86 | 6.23 |
| Science/Tech | B evaluate | 95-104 | 40 | 667,899 | +1.17 ** | 0.86 | -1.33 | 0.87 |


## Politics only: taker net by horizon, half and band

| horizon | half | price paid | day-clusters | contracts | taker net c | +-1.28 SE |
|---|---|---|---|---|---|---|
| a <1h | A select | 05-14 | 36 | 697,521 | -0.44 | 8.51 |
| a <1h | A select | 15-24 | 26 | 159,915 | -12.87 | 3.02 |
| a <1h | A select | 25-34 | 22 | 123,895 | -7.71 | 14.31 |
| a <1h | A select | 35-44 | 18 | 68,340 | -0.51 | 7.86 |
| a <1h | A select | 45-54 | 21 | 61,159 | -3.12 | 7.73 |
| a <1h | A select | 55-64 | 20 | 57,373 | +4.39 ** | 4.30 |
| a <1h | A select | 65-74 | 19 | 106,450 | +1.94 | 9.14 |
| a <1h | A select | 75-84 | 23 | 154,350 | -0.81 | 12.97 |
| a <1h | A select | 85-94 | 30 | 290,323 | -1.01 | 5.32 |
| a <1h | A select | 95-104 | 55 | 2,970,030 | +0.15 | 1.04 |
| a <1h | B evaluate | 05-14 | 44 | 1,414,126 | -6.70 | 0.72 |
| a <1h | B evaluate | 15-24 | 26 | 67,823 | +16.97 | 23.52 |
| a <1h | B evaluate | 25-34 | 25 | 29,411 | +5.31 | 9.21 |
| a <1h | B evaluate | 35-44 | 22 | 27,711 | +34.48 ** | 13.67 |
| a <1h | B evaluate | 45-54 | 18 | 23,887 | +16.87 ** | 14.67 |
| a <1h | B evaluate | 55-64 | 16 | 33,872 | -16.71 | 21.36 |
| a <1h | B evaluate | 65-74 | 18 | 32,484 | -5.65 | 13.68 |
| a <1h | B evaluate | 75-84 | 24 | 58,939 | -2.86 | 9.80 |
| a <1h | B evaluate | 85-94 | 34 | 999,035 | +4.84 ** | 1.95 |
| a <1h | B evaluate | 95-104 | 51 | 1,699,941 | +1.98 ** | 1.13 |
| b 1-6h | A select | 05-14 | 63 | 2,054,055 | -0.73 | 7.68 |
| b 1-6h | A select | 15-24 | 53 | 750,554 | +11.17 | 13.43 |
| b 1-6h | A select | 25-34 | 49 | 646,406 | +16.34 ** | 13.13 |
| b 1-6h | A select | 35-44 | 44 | 556,999 | +3.82 | 13.12 |
| b 1-6h | A select | 45-54 | 46 | 413,127 | -1.87 | 4.68 |
| b 1-6h | A select | 55-64 | 44 | 592,877 | -4.93 | 4.36 |
| b 1-6h | A select | 65-74 | 50 | 531,945 | -10.84 | 9.03 |
| b 1-6h | A select | 75-84 | 53 | 627,088 | -15.48 | 9.90 |
| b 1-6h | A select | 85-94 | 62 | 1,211,706 | -11.60 | 12.11 |
| b 1-6h | A select | 95-104 | 80 | 4,007,698 | -3.12 | 2.88 |
| b 1-6h | B evaluate | 05-14 | 63 | 4,632,251 | -8.14 | 1.25 |
| b 1-6h | B evaluate | 15-24 | 55 | 638,803 | -7.39 | 3.72 |
| b 1-6h | B evaluate | 25-34 | 57 | 472,115 | -2.65 | 4.60 |
| b 1-6h | B evaluate | 35-44 | 52 | 466,756 | -3.66 | 4.29 |
| b 1-6h | B evaluate | 45-54 | 54 | 545,408 | -7.90 | 3.79 |
| b 1-6h | B evaluate | 55-64 | 52 | 477,806 | -12.34 | 4.54 |
| b 1-6h | B evaluate | 65-74 | 54 | 457,803 | -6.33 | 3.46 |
| b 1-6h | B evaluate | 75-84 | 55 | 442,785 | -3.00 | 2.92 |
| b 1-6h | B evaluate | 85-94 | 57 | 3,169,709 | +6.17 ** | 2.13 |
| b 1-6h | B evaluate | 95-104 | 72 | 3,524,975 | +0.59 | 0.77 |
| c 6-24h | A select | 05-14 | 90 | 4,868,976 | -7.33 | 1.45 |
| c 6-24h | A select | 15-24 | 78 | 2,080,206 | -5.21 | 8.01 |
| c 6-24h | A select | 25-34 | 72 | 1,003,356 | -7.18 | 8.88 |
| c 6-24h | A select | 35-44 | 68 | 1,285,701 | -11.93 | 6.54 |
| c 6-24h | A select | 45-54 | 69 | 881,464 | -7.05 | 7.54 |
| c 6-24h | A select | 55-64 | 66 | 1,332,849 | -19.06 | 15.29 |
| c 6-24h | A select | 65-74 | 72 | 1,255,792 | -4.59 | 7.94 |
| c 6-24h | A select | 75-84 | 78 | 1,326,615 | -2.53 | 9.64 |
| c 6-24h | A select | 85-94 | 82 | 3,296,331 | +4.88 ** | 2.56 |
| c 6-24h | A select | 95-104 | 99 | 5,877,366 | +1.42 ** | 0.36 |
| c 6-24h | B evaluate | 05-14 | 86 | 10,167,956 | -7.33 | 0.69 |
| c 6-24h | B evaluate | 15-24 | 74 | 2,271,130 | -13.92 | 2.39 |
| c 6-24h | B evaluate | 25-34 | 77 | 909,587 | -7.56 | 3.43 |
| c 6-24h | B evaluate | 35-44 | 75 | 864,528 | -4.60 | 2.75 |
| c 6-24h | B evaluate | 45-54 | 78 | 944,684 | -5.33 | 2.38 |
| c 6-24h | B evaluate | 55-64 | 75 | 912,789 | -9.02 | 2.68 |
| c 6-24h | B evaluate | 65-74 | 77 | 825,497 | -5.50 | 2.84 |
| c 6-24h | B evaluate | 75-84 | 77 | 1,125,043 | +4.67 ** | 2.54 |
| c 6-24h | B evaluate | 85-94 | 81 | 3,733,899 | +5.75 ** | 1.68 |
| c 6-24h | B evaluate | 95-104 | 96 | 8,281,095 | +1.54 ** | 0.24 |
| d 1-3d | A select | 05-14 | 87 | 2,996,192 | -6.28 | 2.57 |
| d 1-3d | A select | 15-24 | 78 | 2,024,185 | -5.64 | 8.68 |
| d 1-3d | A select | 25-34 | 74 | 789,697 | +15.98 ** | 12.13 |
| d 1-3d | A select | 35-44 | 72 | 955,677 | -3.05 | 14.04 |
| d 1-3d | A select | 45-54 | 62 | 1,159,368 | -10.15 | 8.78 |
| d 1-3d | A select | 55-64 | 63 | 771,687 | -11.29 | 9.06 |
| d 1-3d | A select | 65-74 | 75 | 892,771 | -11.44 | 15.63 |
| d 1-3d | A select | 75-84 | 77 | 1,409,061 | -4.44 | 8.96 |
| d 1-3d | A select | 85-94 | 83 | 1,500,698 | +0.61 | 4.64 |
| d 1-3d | A select | 95-104 | 102 | 5,329,515 | +1.84 ** | 0.27 |
| d 1-3d | B evaluate | 05-14 | 87 | 23,179,770 | -9.14 | 0.57 |
| d 1-3d | B evaluate | 15-24 | 84 | 3,282,151 | -18.14 | 0.92 |
| d 1-3d | B evaluate | 25-34 | 86 | 2,127,738 | -25.76 | 4.62 |
| d 1-3d | B evaluate | 35-44 | 83 | 1,489,914 | -22.43 | 4.07 |
| d 1-3d | B evaluate | 45-54 | 78 | 787,221 | -2.61 | 6.29 |
| d 1-3d | B evaluate | 55-64 | 71 | 1,130,422 | -1.21 | 9.59 |
| d 1-3d | B evaluate | 65-74 | 79 | 1,263,747 | +21.32 ** | 5.39 |
| d 1-3d | B evaluate | 75-84 | 85 | 1,919,177 | +14.75 ** | 2.09 |
| d 1-3d | B evaluate | 85-94 | 88 | 10,732,642 | +7.88 ** | 0.40 |
| d 1-3d | B evaluate | 95-104 | 96 | 24,869,636 | +1.58 ** | 0.25 |
| e 3-7d | A select | 05-14 | 82 | 4,515,412 | -6.30 | 1.73 |
| e 3-7d | A select | 15-24 | 73 | 1,456,639 | -7.38 | 6.96 |
| e 3-7d | A select | 25-34 | 69 | 1,347,091 | +12.24 | 16.53 |
| e 3-7d | A select | 35-44 | 69 | 1,693,452 | +18.57 ** | 13.41 |
| e 3-7d | A select | 45-54 | 59 | 1,493,180 | -10.79 | 5.67 |
| e 3-7d | A select | 55-64 | 60 | 1,444,673 | -19.03 | 7.71 |
| e 3-7d | A select | 65-74 | 67 | 1,363,901 | -10.08 | 17.67 |
| e 3-7d | A select | 75-84 | 66 | 1,649,658 | -0.66 | 13.62 |
| e 3-7d | A select | 85-94 | 80 | 2,116,370 | +2.85 | 3.63 |
| e 3-7d | A select | 95-104 | 85 | 7,580,439 | +1.25 ** | 0.53 |
| e 3-7d | B evaluate | 05-14 | 76 | 22,700,053 | -8.92 | 0.61 |
| e 3-7d | B evaluate | 15-24 | 81 | 6,284,749 | -17.53 | 0.69 |
| e 3-7d | B evaluate | 25-34 | 81 | 1,418,782 | -14.46 | 5.41 |
| e 3-7d | B evaluate | 35-44 | 73 | 1,411,289 | -3.15 | 5.84 |
| e 3-7d | B evaluate | 45-54 | 69 | 1,328,450 | -1.59 | 4.39 |
| e 3-7d | B evaluate | 55-64 | 67 | 1,342,350 | -15.02 | 3.40 |
| e 3-7d | B evaluate | 65-74 | 80 | 1,520,945 | -6.15 | 7.70 |
| e 3-7d | B evaluate | 75-84 | 82 | 2,412,329 | +12.74 ** | 2.14 |
| e 3-7d | B evaluate | 85-94 | 87 | 10,485,827 | +8.08 ** | 0.66 |
| e 3-7d | B evaluate | 95-104 | 85 | 9,715,397 | +2.48 ** | 0.23 |
| f >7d | A select | 05-14 | 126 | 201,271,242 | -5.42 | 1.47 |
| f >7d | A select | 15-24 | 130 | 80,152,198 | -4.73 | 4.59 |
| f >7d | A select | 25-34 | 130 | 63,881,096 | -1.76 | 7.28 |
| f >7d | A select | 35-44 | 123 | 142,362,544 | -31.06 | 11.12 |
| f >7d | A select | 45-54 | 119 | 105,895,160 | -13.87 | 5.59 |
| f >7d | A select | 55-64 | 116 | 160,284,692 | +30.21 ** | 9.50 |
| f >7d | A select | 65-74 | 131 | 52,954,480 | +5.68 | 6.81 |
| f >7d | A select | 75-84 | 134 | 53,732,078 | +1.47 | 4.77 |
| f >7d | A select | 85-94 | 133 | 98,946,494 | +3.82 ** | 1.56 |
| f >7d | A select | 95-104 | 119 | 311,424,165 | +1.46 ** | 0.14 |
| f >7d | B evaluate | 05-14 | 71 | 51,265,050 | -8.91 | 1.16 |
| f >7d | B evaluate | 15-24 | 83 | 29,638,783 | -17.97 | 1.78 |
| f >7d | B evaluate | 25-34 | 80 | 9,029,067 | -23.86 | 3.45 |
| f >7d | B evaluate | 35-44 | 79 | 4,494,134 | -17.36 | 4.71 |
| f >7d | B evaluate | 45-54 | 71 | 3,982,716 | -0.95 | 1.57 |
| f >7d | B evaluate | 55-64 | 76 | 3,916,947 | +3.66 | 7.92 |
| f >7d | B evaluate | 65-74 | 80 | 6,282,697 | +16.88 ** | 3.49 |
| f >7d | B evaluate | 75-84 | 81 | 18,183,391 | +17.20 ** | 1.10 |
| f >7d | B evaluate | 85-94 | 81 | 32,322,210 | +8.85 ** | 0.85 |
| f >7d | B evaluate | 95-104 | 76 | 17,794,193 | +2.52 ** | 0.46 |


## Mean bias of YES price 10-90c, evaluation half (what calibratedYesRate() assumes is zero)

| group | day-clusters | contracts | realised YES minus price (c) | +-1.28 SE |
|---|---|---|---|---|
| Sports | 146 | 8,751,736,680 | -0.56 | 0.41 |
| Politics | 116 | 183,124,261 | -1.24 | 1.38 |
| Crypto | 146 | 330,295,176 | +1.28 | 1.80 |
| Finance | 127 | 105,553,389 | -0.92 | 2.82 |
| Weather | 146 | 33,636,980 | -0.46 | 0.58 |
| Entertainment | 140 | 28,360,785 | -1.06 | 3.98 |
| Other | 137 | 18,821,491 | +2.44 | 4.47 |
| World Events | 19 | 7,080,266 | +15.24 | 13.09 |
| Media | 95 | 8,814,959 | -11.16 | 3.23 |
| Esports | 32 | 15,282,816 | +4.39 | 4.72 |
| Science/Tech | 43 | 4,634,264 | +16.87 | 12.96 |

