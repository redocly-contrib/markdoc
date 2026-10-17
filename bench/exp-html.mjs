// The HTML handler (`htmlTags()` from dist/html) against Redocly Realm's own
// `processHtmlTokens`, which it was ported from.
//
//   node bench/exp-html.mjs [fuzz iterations]
//
// The reference is Realm's file as it is in the Redocly repo (REDOCLY_REPO),
// bundled on the fly with esbuild and applied to published 0.6.4's tokens,
// exactly as Realm's parse cache does. Nothing from it is copied here.
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadMarkdoc } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REDOCLY_REPO || '/Users/romanhotsiy/Projects/redocly';
const SOURCE = path.join(REPO, 'packages/realm-plus/src/content-layer/markdown/utils/html-tokens.ts');
const OUT = path.join(here, '.cache', 'realm-html-tokens.cjs');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
buildSync({
  entryPoints: [SOURCE],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: OUT,
  logLevel: 'error',
  // Realm imports Markdoc only for a schema it never runs here.
  alias: { '@markdoc/markdoc': require.resolve('markdoc-baseline') },
});
const { processHtmlTokens } = require(OUT);

const B = loadMarkdoc('baseline');
const M = loadMarkdoc('candidate');
const { htmlTags } = require('../dist/html.js');

const CONFIG = { html: true, allowIndentation: true, allowComments: true };
const tokenizer = new B.Tokenizer(CONFIG);

function outcome(fn) {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return `THREW ${e && e.constructor && e.constructor.name}`;
  }
}
const viaRealm = (src, args) => outcome(() => B.parse(processHtmlTokens(tokenizer.tokenize(src)), args));
const viaHandler = (src, args) => outcome(() => M.parse(src, { ...args, ...CONFIG, html: htmlTags() }));

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n  realm:   …${a.slice(Math.max(0, i - 150), i + 150)}\n  handler: …${b.slice(Math.max(0, i - 150), i + 150)}`;
}

const { pages, descriptions } = loadCorpus();
let failures = 0;
for (const [label, sources, args] of [
  ['pages (Realm: slots)', pages.map((p) => p.source), { slots: true }],
  ['pages (portal: file, slots)', pages.map((p) => p.source), { file: 'page.md', slots: true }],
  ['descriptions (compact)', descriptions, { compact: true }],
]) {
  let bad = 0;
  let withHtml = 0;
  for (let i = 0; i < sources.length; i++) {
    if (/<[a-zA-Z/!?]/.test(sources[i])) withHtml++;
    const a = viaRealm(sources[i], args);
    if (a.startsWith('THREW')) continue;
    const b = viaHandler(sources[i], args);
    if (a !== b) {
      if (bad < 3) console.log(`  ✗ ${label} doc #${i} ${firstDiff(a, b)}`);
      bad++;
    }
  }
  failures += bad;
  console.log(`${bad ? '✗' : '✓'} ${label}: ${sources.length - bad}/${sources.length} identical (${withHtml} contain HTML)`);
}

// Fuzz: random documents made of HTML and markdown fragments.
let seed = 7;
const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rng() * a.length)];
const FRAGMENTS = [
  '<div>', '</div>', '<details>', '</details>', '<summary>Sum</summary>', '<p>', '</p>', '<br>', '<br/>',
  '<img src="x.png" alt="a">', '<span class="c" style="color: red; --x: 1">', '</span>', '<b>', '</b>',
  '<input value="v" checked>', '<textarea value="t">', '</textarea>', '<GridItem<T>>', '<MyComponent />',
  '<a href="/x?a=1&amp;b=2">', '</a>', '<table>', '<tr>', '<td>', '</td>', '</tr>', '</table>', '<!-- c -->',
  '<script>x < y</script>', '<h2 id="h">', '</h2>', '<ul>', '<li>', '</li>', '</ul>',
  '', '', '\n', '\n\n', 'text', '**bold**', '*em*', '`code`', '[l](/u)', '- item', '> quote', '# Heading',
  '{% note %}', '{% /note %}', '{% $v %}', '  ', '| a |\n|---|\n| b |', '```\ncode\n```',
];
const iterations = Number(process.argv[2] || 3000);
let fuzzBad = 0;
for (let it = 0; it < iterations; it++) {
  let src = '';
  const n = 1 + Math.floor(rng() * 16);
  for (let j = 0; j < n; j++) src += pick(FRAGMENTS) + (rng() < 0.3 ? '\n' : rng() < 0.5 ? ' ' : '');
  for (const args of [{ slots: true }, { compact: true }]) {
    const a = viaRealm(src, args);
    if (a.startsWith('THREW')) continue;
    if (a !== viaHandler(src, args)) {
      if (fuzzBad < 3) console.log(`  ✗ fuzz ${JSON.stringify(src)} ${firstDiff(a, viaHandler(src, args))}`);
      fuzzBad++;
    }
  }
}
console.log(`${fuzzBad ? '✗' : '✓'} ${iterations} random HTML documents × 2 settings: ${fuzzBad} mismatches`);
if (failures || fuzzBad) process.exitCode = 1;
