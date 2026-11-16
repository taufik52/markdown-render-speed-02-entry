// Driver for the markdown-render-speed-02 entry.
//
// Reads $MAKEFUN_INPUT_DIR/cases.json (default /input), renders each case
// alone with parse() from ./parse.js, and writes
// $MAKEFUN_OUTPUT_DIR/html.json (default /output) as a JSON array of the
// HTML strings, one per case, in the cases' order.
//
// Run with node (the grader uses node 22; no build step, no install).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main() {
  const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw);
  const html = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

main();
