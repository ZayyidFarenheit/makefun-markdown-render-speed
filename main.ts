// Driver for the markdown-render-speed entry. It reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR when set), renders each case
// alone with parse() from ./parse.js, and writes the HTML strings, in
// order, to /output/html.json (or $MAKEFUN_OUTPUT_DIR). Each case is
// rendered in isolation: parse() keeps nothing from an earlier call, so
// the output for a case depends only on that case's markdown. The JSON
// is written exactly as JSON.stringify produces it, with no trailing
// newline, matching the scorer's byte-for-byte comparison.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // A case is an object with a markdown string; tolerate a bare string.
  const md = typeof cases[i] === 'string' ? cases[i] : (cases[i].markdown ?? '');
  html[i] = parse(md);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
