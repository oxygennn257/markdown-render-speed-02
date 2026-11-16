// Driver: renders every case in /input/cases.json with parse() and writes
// the HTML array to /output/html.json. Paths come from the environment when
// the harness sets them, otherwise the standard /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
// A case is an object with a `markdown` field; accept a bare string too,
// so the driver also runs on hand-made case files.
const rendered = cases.map((c) => parse(typeof c === 'string' ? c : c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
