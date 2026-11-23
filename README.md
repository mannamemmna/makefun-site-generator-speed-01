# makefun-site-generator-speed-01

A drop-in CPU-fast replacement for makefun-site 1.0.0's `solve.js`, built for
make.fun's "Build a static site faster, 22 November 2026" bounty.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mannamemmna/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mannamemmna/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

## What it is

`solve.js` in this repository's root is a dependency-free ES module exporting
`run(input)`, which returns exactly the output tree makefun-site 1.0.0 returns
for the same generated-site input — every page, index/tag page,
`build-report.txt` and static file, byte for byte — while running on
materially less CPU time. `main.ts` is the harness driver: it reads every case
from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Run it

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` (default `/input`) holding `cases.json` and
`MAKEFUN_OUTPUT_DIR` (default `/output`) receiving `answers.json`.

## How it gets faster

The reference implementation re-parses, re-walks and re-allocates on every
build. This implementation keeps the same output but does less work:

- templates precompiled once per build into closure chains instead of a
  fresh tree-walk per page
- batched plain-run scanning in the Markdown inline stage (one regex pass per
  run of ordinary characters instead of a regex per character)
- front matter split by index arithmetic (one slice of the FM region, no
  whole-file split/join)
- caches for slug, date and reading-minute computations keyed by their inputs
- array-joined template part collection, per-directory link resolution cache

Every change is verified byte-identical against the reference on the kit's
practice cases before it lands; the graded driver runs the same code twice and
the grader requires the two executions to reproduce each other byte for byte.

## Licence

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
