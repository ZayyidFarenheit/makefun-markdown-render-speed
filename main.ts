// Driver: renders every case in /input/cases.json with parse() and writes
// /output/html.json. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the
// default directories when set.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const rendered: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  rendered[k] = parse(cases[k].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
