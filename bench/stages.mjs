// Stage-by-stage breakdown of the Markdoc pipeline for one build of the
// library, so we know where time goes before optimizing anything.
//
//   node --expose-gc bench/stages.mjs [baseline|candidate]
//
// Build time:  tokenize -> parse -> validate -> compact+serialize
// Runtime:     revive (fromJSON) -> transform -> render (html, react)
import { createRequire } from 'node:module';
import { loadCorpus } from './lib/corpus.mjs';
import { buildConfig, buildComponents } from './lib/config.mjs';
import { compare, fmtMs, fmtBytes } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const which = process.argv[2] || 'baseline';
const mod = require(which === 'baseline' ? 'markdoc-baseline' : '../dist/index.js');
const Markdoc = mod.default || mod;
const React = require('react');

const { pages, descriptions } = loadCorpus();
const config = buildConfig(Markdoc, pages);
const components = buildComponents(config);
if (process.env.NODE_ENV !== 'production')
  throw new Error('Run with NODE_ENV=production so React dev warnings do not skew timing');

// The portal's tokenizer settings for pages; API descriptions use the default.
const pageTokenizer = new Markdoc.Tokenizer({
  html: true,
  allowIndentation: true,
  allowComments: true,
});
const descTokenizer = new Markdoc.Tokenizer();

function stagesFor(label, sources, tokenizer, parseArgs) {
  // Precompute each stage's input once, so every stage is timed alone.
  const tokens = sources.map((s) => tokenizer.tokenize(s));
  const asts = tokens.map((t) => Markdoc.parse(t, parseArgs));
  const json = asts.map((a) => JSON.stringify(Markdoc.compact ? Markdoc.compact(a) : a));
  const revived = json.map((j) => Markdoc.Ast.fromJSON(j));
  const trees = revived.map((a) => Markdoc.transform(a, config));

  const results = compare(
    {
      tokenize: () => { for (const s of sources) tokenizer.tokenize(s); },
      parse: () => { for (const t of tokens) Markdoc.parse(t, parseArgs); },
      validate: () => { for (const a of asts) Markdoc.validate(a, config); },
      'compact+stringify': () => {
        for (const a of asts) JSON.stringify(Markdoc.compact ? Markdoc.compact(a) : a);
      },
      revive: () => { for (const j of json) Markdoc.Ast.fromJSON(j); },
      transform: () => { for (const a of revived) Markdoc.transform(a, config); },
      'render html': () => { for (const t of trees) Markdoc.renderers.html(t); },
      'render react': () => {
        for (const t of trees) Markdoc.renderers.react(t, React, { components });
      },
    },
    { rounds: 9, warmup: 2 }
  );

  const total = Object.values(results).reduce((n, r) => n + r.cpu.median, 0);
  const bytes = json.reduce((n, j) => n + j.length, 0);
  console.log(`\n${label}  (${sources.length} docs, stored JSON ${fmtBytes(bytes)})`);
  for (const [name, r] of Object.entries(results)) {
    const pct = ((r.cpu.median / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((r.cpu.median / total) * 40));
    console.log(`  ${name.padEnd(20)}${fmtMs(r.cpu.median).padStart(10)}  ${pct.padStart(5)}%  ${bar}`);
  }
  return { results, bytes };
}

console.log(`@redocly/markdoc ${which === 'baseline' ? require('markdoc-baseline/package.json').version : 'candidate (dist)'}`);
stagesFor('PAGES', pages.map((p) => p.source), pageTokenizer, undefined);
stagesFor('DESCRIPTIONS', descriptions, descTokenizer, { compact: true });
