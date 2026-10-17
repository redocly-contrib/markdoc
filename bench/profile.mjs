// Profiles one stage and prints the functions with the most self time.
//
//   NODE_ENV=production node bench/profile.mjs <stage> [pages|descriptions] [baseline|candidate]
//
// Stages: source (source → AST), tokenize and parse (0.6.4 only), validate,
// stringify, revive, transform, html, react.
//
// Uses the inspector protocol directly, so no profile files are left behind.
import { createRequire } from 'node:module';
import { Session } from 'node:inspector';
import { loadCorpus } from './lib/corpus.mjs';
import { buildConfig, buildComponents } from './lib/config.mjs';

const require = createRequire(import.meta.url);
const [stage, corpusName = 'pages', which = 'baseline'] = process.argv.slice(2);
const mod = require(which === 'baseline'
  ? 'markdoc-baseline'
  : '../dist/index.js');
const Markdoc = mod.default || mod;
const React = require('react');

const corpus = loadCorpus();
const config = buildConfig(Markdoc, corpus.pages);
const components = buildComponents(config);
const sources =
  corpusName === 'pages'
    ? corpus.pages.map((p) => p.source)
    : corpus.descriptions;
const pageConfig = { html: true, allowIndentation: true, allowComments: true };
const options = corpusName === 'pages' ? pageConfig : {};
const parseArgs = corpusName === 'pages' ? undefined : { compact: true };
// Only 0.6.4 has a Tokenizer; this branch parses source directly.
const tokenizer = Markdoc.Tokenizer ? new Markdoc.Tokenizer(options) : undefined;

const tokens = tokenizer ? sources.map((s) => tokenizer.tokenize(s)) : [];
const asts = tokenizer
  ? tokens.map((t) => Markdoc.parse(t, parseArgs))
  : sources.map((s) => Markdoc.parse(s, { ...parseArgs, ...options }));
const json = asts.map((a) => JSON.stringify(Markdoc.compact(a)));
const revived = json.map((j) => Markdoc.Ast.fromJSON(j));
const trees = revived.map((a) => Markdoc.transform(a, config));

const work = {
  tokenize: () => {
    for (const s of sources) tokenizer.tokenize(s);
  },
  firstheading: () => {
    for (const s of sources) Markdoc.parseFirstHeading(s, { ...parseArgs, ...options, slots: true });
  },
  source: () => {
    for (const s of sources) {
      if (tokenizer) Markdoc.parse(tokenizer.tokenize(s), parseArgs);
      else Markdoc.parse(s, { ...parseArgs, ...options });
    }
  },
  parse: () => {
    for (const t of tokens) Markdoc.parse(t, parseArgs);
  },
  validate: () => {
    for (const a of asts) Markdoc.validate(a, config);
  },
  stringify: () => {
    for (const a of asts) JSON.stringify(Markdoc.compact(a));
  },
  revive: () => {
    for (const j of json) Markdoc.Ast.fromJSON(j);
  },
  transform: () => {
    for (const a of revived) Markdoc.transform(a, config);
  },
  html: () => {
    for (const t of trees) Markdoc.renderers.html(t);
  },
  react: () => {
    for (const t of trees) Markdoc.renderers.react(t, React, { components });
  },
}[stage];
if (!work) throw new Error(`unknown stage ${stage}`);

for (let i = 0; i < 2; i++) work(); // warm up

const session = new Session();
session.connect();
const post = (method, params) =>
  new Promise((res, rej) =>
    session.post(method, params, (e, r) => (e ? rej(e) : res(r)))
  );

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 });
await post('Profiler.start');
for (let i = 0; i < 6; i++) work();
const { profile } = await post('Profiler.stop');

// Aggregate self time per function.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.split('/').slice(-2).join('/');
  const key = `${functionName || '(anonymous)'}  ${file}:${lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (dt[i] || 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`\nself time — ${stage} / ${corpusName} / ${which}`);
for (const [k, us] of [...self.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 18))
  console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
