// The Markdoc pipeline as benchmark stages, shared by the A/B worker and the
// output-identity check.
//
// Build time:  tokenize -> parse -> validate -> compact+stringify
// Runtime:     revive (fromJSON) -> transform -> render (html, react)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCorpus } from './corpus.mjs';
import { buildConfig, buildComponents } from './config.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const React = require('react');

/** 'baseline' is the published 0.6.4; 'candidate' is this repo's dist build. */
export function loadMarkdoc(which) {
  const id =
    which === 'baseline'
      ? 'markdoc-baseline'
      : which === 'candidate'
      ? path.join(root, 'dist/index.js')
      : path.resolve(which);
  const m = require(id);
  return m.default || m;
}

export const CORPORA = {
  pages: {
    label: 'PAGES',
    // The portal's tokenizer settings for pages.
    tokenizer: (M) =>
      new M.Tokenizer({ html: true, allowIndentation: true, allowComments: true }),
    parseArgs: undefined,
    sources: (c) => c.pages.map((p) => p.source),
  },
  descriptions: {
    label: 'DESCRIPTIONS',
    // API descriptions use the default tokenizer and compact mode.
    tokenizer: (M) => new M.Tokenizer(),
    parseArgs: { compact: true },
    sources: (c) => c.descriptions,
  },
};

export const STAGES = [
  'tokenize',
  'parse',
  'validate',
  'compact+stringify',
  'revive',
  'transform',
  'render html',
  'render react',
];

/** Extra stages that only exist on builds with `prepareConfig`. */
export const PREPARED_STAGES = ['validate (prepared)', 'transform (prepared)'];

/** Precomputes every stage's input once, so each stage is timed alone. */
export function prepare(M, corpusName) {
  const corpus = loadCorpus();
  const spec = CORPORA[corpusName];
  const config = buildConfig(M, corpus.pages);
  const components = buildComponents(config);
  const tk = spec.tokenizer(M);
  const sources = spec.sources(corpus);
  const parseArgs = spec.parseArgs;
  const tokens = sources.map((s) => tk.tokenize(s));
  const asts = tokens.map((t) => M.parse(t, parseArgs));
  const json = asts.map((a) => JSON.stringify(M.compact(a)));
  const revived = json.map((j) => M.Ast.fromJSON(j));
  const trees = revived.map((a) => M.transform(a, config));
  // Prepared once, then spread per call the way the portal adds variables.
  const prepared = M.prepareConfig ? M.prepareConfig(config) : undefined;
  return { M, config, prepared, components, tk, sources, parseArgs, tokens, asts, json, revived, trees };
}

/** One full pass of a stage over the corpus. */
export function stageFn(name, s) {
  const { M } = s;
  switch (name) {
    case 'tokenize':
      return () => { for (const x of s.sources) s.tk.tokenize(x); };
    case 'parse':
      return () => { for (const t of s.tokens) M.parse(t, s.parseArgs); };
    case 'validate':
      return () => { for (const a of s.asts) M.validate(a, { ...s.config, variables: {} }); };
    case 'compact+stringify':
      return () => { for (const a of s.asts) JSON.stringify(M.compact(a)); };
    case 'revive':
      return () => { for (const j of s.json) M.Ast.fromJSON(j); };
    case 'transform':
      return () => { for (const a of s.revived) M.transform(a, { ...s.config, variables: {} }); };
    case 'transform (prepared)':
      return () => { for (const a of s.revived) M.transform(a, { ...s.prepared, variables: {} }); };
    case 'validate (prepared)':
      return () => { for (const a of s.asts) M.validate(a, { ...s.prepared, variables: {} }); };
    case 'render html':
      return () => { for (const t of s.trees) M.renderers.html(t); };
    case 'render react':
      return () => {
        for (const t of s.trees) M.renderers.react(t, React, { components: s.components });
      };
    default:
      throw new Error(`unknown stage ${name}`);
  }
}
