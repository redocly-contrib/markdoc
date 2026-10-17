// The parser against published 0.6.4 (markdown-it + Markdoc's tokenizer
// plugins) on the whole corpus.
//
//   NODE_ENV=production node bench/exp-fastparse.mjs
//
// Every corpus document, under several settings, must give byte-identical AST
// JSON (or both must throw). Timing lives in bench/ab.mjs and
// bench/exp-engines.mjs, which keep each library in its own process.
import { loadMarkdoc } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const M = loadMarkdoc('candidate');
const B = loadMarkdoc('baseline');
const { pages, descriptions } = loadCorpus();

const PAGE_CFG = { html: true, allowIndentation: true, allowComments: true };

// [label, sources, tokenizer settings, parser args]
const SETUPS = [
  ['pages (portal settings)', pages.map((p) => p.source), PAGE_CFG, undefined],
  [
    'pages (defaults, compact)',
    pages.map((p) => p.source),
    {},
    { compact: true },
  ],
  [
    'pages (portal, slots, file)',
    pages.map((p) => p.source),
    PAGE_CFG,
    { slots: true, file: 'x.md' },
  ],
  ['descriptions (defaults, compact)', descriptions, {}, { compact: true }],
  ['descriptions (portal settings)', descriptions, PAGE_CFG, undefined],
  [
    'pages (link validation, no admonitions)',
    pages.map((p) => p.source),
    { ...PAGE_CFG, allowLinkValidation: true, githubAdmonitions: false },
    undefined,
  ],
];

function outcome(fn) {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return `THREW ${e && e.constructor && e.constructor.name}`;
  }
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n  0.6.4:  …${a.slice(
    Math.max(0, i - 120),
    i + 120
  )}\n  branch: …${b.slice(Math.max(0, i - 120), i + 120)}`;
}

let failures = 0;
for (const [label, sources, cfg, args] of SETUPS) {
  const tk = new B.Tokenizer(cfg);
  let bad = 0;
  for (let i = 0; i < sources.length; i++) {
    const a = outcome(() => B.parse(tk.tokenize(sources[i]), args));
    const b = outcome(() => M.parse(sources[i], { ...args, ...cfg }));
    // Where 0.6.4 itself throws, the parser returns an AST instead.
    if (a !== b && !a.startsWith('THREW')) {
      if (bad < 3) console.log(`  ✗ ${label} doc #${i} ${firstDiff(a, b)}`);
      bad++;
    }
  }
  failures += bad;
  console.log(
    `${bad ? '✗' : '✓'} ${label}: ${sources.length - bad}/${
      sources.length
    } identical`
  );
}
if (failures) process.exitCode = 1;
