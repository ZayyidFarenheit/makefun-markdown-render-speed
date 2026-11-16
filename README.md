# Fast Markdown renderer

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![Rank](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![Reward](https://make.fun/badge/markdown-render-speed-02/ZayyidFarenheit/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch for the [Markdown render speed bounty](https://make.fun/bounty/markdown-render-speed-02). It uses block parsing followed by inline rendering, with document-local reference definitions and no cross-case cache.

Run `node main.ts`. Input defaults to `/input/cases.json`; output is `/output/html.json`. Set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` to use other directories.

Referral code: **zfpsetbs**.

Validation: 720/720 practice cases match the reference byte for byte. A second locally generated set also matches 720/720. Five fresh-process practice runs measured pure parsing at 0.884 s median / 0.863 s minimum on the development host (Node 24.22.1); these are local measurements, not official grader timings.
