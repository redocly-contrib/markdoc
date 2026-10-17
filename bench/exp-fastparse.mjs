// Experiment: the fast parser (src/fastparse) against Tokenizer + parse.
//
//   NODE_ENV=production node --expose-gc bench/exp-fastparse.mjs [check|time|both]
//
// check: every corpus document, under several tokenizer/parser settings, must
//        give byte-identical AST JSON (or both must throw).
// time:  CPU time of tokenize+parse vs fastParse, same build, same process.
import { loadMarkdoc } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';
import { compare, report } from './lib/harness.mjs';

const M = loadMarkdoc('candidate');
const mode = process.argv[2] || 'both';
const { pages, descriptions } = loadCorpus();

const PAGE_CFG = { html: true, allowIndentation: true, allowComments: true };

// [label, sources, tokenizer config, parser args]
const SETUPS = [
  ['pages (portal settings)', pages.map((p) => p.source), PAGE_CFG, undefined],
  ['pages (defaults, compact)', pages.map((p) => p.source), {}, { compact: true }],
  ['pages (portal, slots, file)', pages.map((p) => p.source), PAGE_CFG, { slots: true, file: 'x.md' }],
  ['descriptions (defaults, compact)', descriptions, {}, { compact: true }],
  ['descriptions (portal settings)', descriptions, PAGE_CFG, undefined],
  ['pages (link validation, no admonitions)', pages.map((p) => p.source),
    { ...PAGE_CFG, allowLinkValidation: true, githubAdmonitions: false }, undefined],
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
  return `at ${i}:\n  tokens: …${a.slice(Math.max(0, i - 120), i + 120)}\n  fast:   …${b.slice(Math.max(0, i - 120), i + 120)}`;
}

if (mode === 'check' || mode === 'both') {
  let failures = 0;
  for (const [label, sources, cfg, args] of SETUPS) {
    const tk = new M.Tokenizer(cfg);
    let bad = 0;
    for (let i = 0; i < sources.length; i++) {
      const a = outcome(() => M.parse(tk.tokenize(sources[i]), args));
      const b = outcome(() => M.fastParse(sources[i], cfg, args));
      if (a !== b) {
        if (bad < 3) console.log(`  ✗ ${label} doc #${i} ${firstDiff(a, b)}`);
        bad++;
      }
    }
    failures += bad;
    console.log(`${bad ? '✗' : '✓'} ${label}: ${sources.length - bad}/${sources.length} identical`);
  }
  if (failures) process.exitCode = 1;
}

if (mode === 'time' || mode === 'both') {
  for (const [label, sources, cfg, args] of [SETUPS[0], SETUPS[3]]) {
    const tk = new M.Tokenizer(cfg);
    report(
      `${label} — source to AST`,
      compare(
        {
          'Tokenizer + parse': () => { for (const s of sources) M.parse(tk.tokenize(s), args); },
          fastParse: () => { for (const s of sources) M.fastParse(s, cfg, args); },
        },
        { rounds: 11, warmup: 3 }
      )
    );
  }
}
