# live-odds-archive

A continuous archive of **publicly available** live sports odds, collected for
market-efficiency research.

Nothing secret lives here: the collector reads the same public bookmaker feed any
browser sees, and the repository contains no API keys, no accounts and no bets.

## What is collected

One JSON line per **change** (odds or score) per match, plus a heartbeat, from the
public `line-lb51.bk6bba-resources.com` feed:

```json
{"ts":"2026-09-13T22:23:01.096Z","id":68024806,"sport":"tennis",
 "t1":"Видманова Д","t2":"Тьен Дж","k1":4.1,"k2":1.22,
 "score":"0-1/0-0/00-00","timer":null,"tb":false}
```

| field | meaning |
|---|---|
| `ts` | observation time (UTC) |
| `id` | bookmaker event id |
| `sport` | `tennis` or `basketball` |
| `t1`,`t2` | competitors as the feed names them |
| `k1`,`k2` | moneyline odds |
| `score` | sets/games/points (tennis) or points/quarter (basketball) |
| `tb` | tiebreak flag (tennis) |

A full snapshot of every market every 30 s would be ~100 MB/day, which no free
storage keeps for long. Recording only changes brings it to **~1–5 MB/day** while
preserving every move.

## Why it runs here

The collector is a plain HTTP poll every 30 s, so it needs to run continuously.
GitHub gives **public** repositories unlimited Actions minutes and allows a job up
to 6 hours, so four 5.5-hour windows cover **~22 hours a day at 30-second
resolution** — for free. A private repo (2000 min/month) or a sleeping free-tier
host cannot come close.

Bandwidth is the only real cost and it is not billed here: each poll fetches a
**0.83 MB gzipped** response, about **2.4 GB/day**.

## Layout

```
collect.mjs                  the collector (no dependencies)
.github/workflows/collect.yml 4 x 5.5h windows per day
data/YYYY-MM-DD.jsonl        today's feed
data/YYYY-MM-DD.jsonl.gz     finished days, compressed
data/.state.json             change-detection memory (git-ignored)
```

## Run it locally

```bash
INTERVAL_SEC=30 node collect.mjs              # forever
DURATION_MIN=10 node collect.mjs              # 10-minute window
ONCE=1 node collect.mjs                       # a single poll (cron-friendly)
```

## Intended use

Testing whether in-play prices carry exploitable inertia — i.e. whether a move in
the live price tends to continue or revert, and whether any such effect is larger
than the cost of entering and exiting. Early single-evening results suggested it is
not (tennis lag-1 autocorrelation −0.0004; basketball −0.068, roughly 5× smaller
than a round-trip cost), but that needs weeks of data to settle.

## Removing it

The archive is disposable: delete the repository and collection stops immediately.
