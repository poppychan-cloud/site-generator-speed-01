[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/poppychan-cloud/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/poppychan-cloud/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01 — a faster makefun-site

A dependency-free drop-in replacement for makefun-site 1.0.0: `solve.js` exports `run(input)`, which returns the
reference build's output tree byte for byte — every page's `index.html`, the index and tag pages,
`build-report.txt` and each static file — and `main.ts` is the house driver that feeds it the cases.

The dialect is makefun-site's own (front matter, Markdown subset, template language, slug rule), re-implemented
for speed: plain text is HTML-escaped in bulk instead of character by character, slugs are memoized per build,
Markdown is lexed and rendered in a single pass with first-character dispatch, word counts are scanned without
allocating the words, and templates render into an array that is joined once. No dependencies, no I/O, no clock:
the output depends on the input alone, exactly as the reference's does.
