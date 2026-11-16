# Fast Markdown renderer

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A from-scratch Markdown renderer for [make.fun's "Make Markdown rendering faster" bounty](https://make.fun/bounty/markdown-render-speed-02).

`parse.js` is a dependency-free ES module whose `parse(markdown)` returns
exactly the HTML that marked 18.1.3 renders with its default options
(GFM on, breaks off, pedantic off, async off), byte for byte — for every
input, computed from the markdown given. It is a two-phase renderer:
block parsing builds a small node tree (collecting link reference
definitions first, since they may be defined after their use), then a
single left-to-right inline scan renders each block's text. No output is
looked up or cached across cases.

`main.ts` is the driver: it reads every case from `/input/cases.json`,
renders each one alone with `parse()`, and writes `/output/html.json`.

## Run

```sh
node main.ts
```

With `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` set, those directories
stand in for `/input` and `/output`.

## License

MIT — see [LICENSE](LICENSE).
