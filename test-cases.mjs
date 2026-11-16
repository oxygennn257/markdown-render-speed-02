// Independent check: compare the fast renderer against marked on every
// practice case, and report mismatches, fallbacks, and timing.
import { parseFast } from './parse.js';
import { marked } from './vendor/marked/marked.esm.js';
import { readFileSync, writeFileSync } from 'node:fs';

const kitDir = '/home/hatch/workspace/makefun/markdown-render-speed-02-kit/markdown-render-speed-02-kit';
const cases = JSON.parse(readFileSync(kitDir + '/practice/input/cases.json', 'utf8'));
const expected = JSON.parse(readFileSync(kitDir + '/practice/reference/expected.json', 'utf8'));
const asMarkdown = (c) => (typeof c === 'string' ? c : (c.markdown ?? c.input ?? c.md ?? JSON.stringify(c)));

console.log('cases:', cases.length, 'expected:', expected.length);
const bad = [];
let fallbacks = 0;
let markedDiffers = 0;
const started = Date.now();
for (let i = 0; i < cases.length; i++) {
  const md = asMarkdown(cases[i]);
  let fast;
  try { fast = parseFast(md); } catch (e) { fast = 'THREW:' + e.message; }
  if (fast === null) { fallbacks++; continue; }
  const ref = marked.parse(md);
  if (fast !== ref) bad.push(i);
  if (ref !== expected[i]) markedDiffers++;
}
console.log('mismatches:', bad.length, 'nulls(fallback):', fallbacks, 'marked!=expected:', markedDiffers, 'time:', Date.now() - started, 'ms');
writeFileSync('/tmp/bad-idx.json', JSON.stringify(bad));
for (const i of bad.slice(0, 15)) {
  const md = asMarkdown(cases[i]);
  console.log('--- case', i, 'IN:', JSON.stringify(md).slice(0, 300));
  console.log('  fast:', JSON.stringify(parseFast(md)).slice(0, 300));
  console.log('  ref :', JSON.stringify(marked.parse(md)).slice(0, 300));
}
