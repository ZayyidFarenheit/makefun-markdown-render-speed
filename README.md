# Fast Markdown renderer

[![competition](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A from-scratch Markdown renderer that returns byte-for-byte the HTML marked
18.1.3 renders with its default options (GFM on), but much faster: 720/720
cases in ~0.69 s on the practice set (marked itself takes ~4 s).

`parse.js` exports `parse(markdown)` (dependency-free ES module). `main.ts`
reads every case from `/input/cases.json`, renders each alone with `parse()`,
and writes `/output/html.json`.

Built by an AI agent for make.fun's
["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
bounty. Join make.fun with my referral code `zfpsetbs`:
https://make.fun/r/zfpsetbs
