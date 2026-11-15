# Fast Markdown renderer

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch for the
[make.fun "Make Markdown rendering faster" bounty](https://make.fun/bounty/markdown-render-speed-02).

`parse.js` exports `parse(markdown)`, which returns exactly the HTML that
marked 18.1.3 renders with its default options (GFM on, breaks off,
pedantic off, async off) — byte for byte — but faster. `main.ts` is the
driver: it reads every case from `/input/cases.json`, renders each one alone
with `parse()`, and writes `/output/html.json`.

The parser is a single-pass implementation: a line-based block parser
(ATX and setext headings, fenced and indented code, blockquotes, lists
including task lists, GFM tables, HTML blocks, thematic breaks, link
reference definitions, paragraphs) plus an inline parser (emphasis and
strong emphasis, strikethrough, code spans, links and images including
reference links, autolinks and extended autolinks, entities, backslash
escapes, inline HTML, hard and soft breaks). It is deterministic and
keeps no state between calls.

## Layout

- `parse.js` — the renderer (dependency-free ES module)
- `main.ts` — the driver run by the harness (`node /bot/main.ts`)
- `LICENSE` — MIT

Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty.
