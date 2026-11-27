# png-squeeze-01-run-20261127-entry

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/giber76/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/giber76/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes 1280×720 screenshots into as few
bytes as it can, built for make.fun's "Squeeze screenshots into the smallest
PNG, 27 November 2026" bounty ($100 in USDC, top 50 share).

## How it works

`main.ts` (Node 22, no dependencies) answers a set of 8 screenshots in one
run (`/input/<id>/image.png` → `/output/<id>/image.png`, ~29 s for the set):

1. **Decode** each screenshot to RGBA with a strict PNG reader (only the
   chunks the contest accepts).
2. **Pick the best lossless form** per image: a palette (count- or
   luminance-ordered, transparent entries first) when it holds at most 256
   colours, grey / grey+alpha when every pixel is grey, RGB / RGBA otherwise,
   with a tRNS key when a single fully-transparent value fits.
3. **Choose each row's filter** (unfiltered, Paeth, or fewest-distinct-byte-
   pairs), screened at zlib level 6.
4. **Compress with its own optimal-parse DEFLATE encoder**: hash-chain match
   search with per-length best distances, a forward dynamic-programming
   optimal parse whose cost model is refined over three iterations from the
   parse's own symbol frequencies, and per-block dynamic Huffman tables —
   falling back to zlib level 9 wherever that is smaller.
5. **Self-verify**: every written PNG is decoded again and compared pixel for
   pixel (including fully transparent pixels' colours); on any mismatch it
   falls back to a plain Paeth-filtered RGBA PNG at zlib level 9.

Deterministic: fixed work budgets only — no clock, no randomness, no
environment reads beyond the input/output directories — so two runs write
identical bytes.

## Local grade (practice set, kit scorer)

| instance | theme | bytes | scale | points |
|----------|-------|------:|------:|-------:|
| i001 | flat  | 12,035 | 13,547 | 741.1 |
| i002 | rich  | 51,746 | 55,063 | 706.8 |
| i003 | alpha | 95,537 | 107,892 | 743.0 |
| i004 | grey  | 102,535 | 110,521 | 714.8 |
| i005 | flat  | 16,552 | 18,669 | 742.3 |
| i006 | rich  | 158,694 | 185,295 | 762.4 |
| i007 | alpha | 59,711 | 64,285 | 714.1 |
| i008 | grey  | 24,507 | 26,807 | 723.9 |

Total 521,317 bytes against 582,179 scale bytes — **score 731,038**
(passed 1, all 8 exact), vs the house baseline fixed-Paeth's 420,399 on the
same set. The reference (brute-force filters + optimal-parse deflate) scores
about 760–790, so this entry sits just below it.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
