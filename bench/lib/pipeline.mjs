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
    config: { html: true, allowIndentation: true, allowComments: true },
    parseArgs: undefined,
    sources: (c) => c.pages.map((p) => p.source),
  },
  descriptions: {
    label: 'DESCRIPTIONS',
    // API descriptions use the default tokenizer and compact mode.
    config: {},
    parseArgs: { compact: true },
    sources: (c) => c.descriptions,
  },
};

export const STAGES = [
  'source → AST',
  'tokenize',
  'parse (tokens)',
  'validate',
  'compact+stringify',
  'revive',
  'transform',
  'render html',
  'render react',
];

/** Stages of the markdown-it token path, which only 0.6.4 has. */
export const TOKEN_STAGES = ['tokenize', 'parse (tokens)'];

/** Extra stages that only exist on builds with `prepareConfig`. */
export const PREPARED_STAGES = ['validate (prepared)', 'transform (prepared)'];

/** Precomputes every stage's input once, so each stage is timed alone. */
export function prepare(M, corpusName) {
  const corpus = loadCorpus();
  const spec = CORPORA[corpusName];
  const markdocConfig = buildConfig(M, corpus.pages);
  const components = buildComponents(markdocConfig);
  const sources = spec.sources(corpus);
  const parseArgs = spec.parseArgs;
  const config = spec.config;
  // 0.6.4 parses markdown-it tokens; this branch parses source directly,
  // taking the tokenizer settings as parse() options.
  const tk = typeof M.Tokenizer === 'function' ? new M.Tokenizer(config) : undefined;
  const direct = tk
    ? (x) => M.parse(tk.tokenize(x), parseArgs)
    : (x) => M.parse(x, { ...parseArgs, ...config });
  const tokens = tk ? sources.map((s) => tk.tokenize(s)) : undefined;
  const asts = tk ? tokens.map((t) => M.parse(t, parseArgs)) : sources.map(direct);
  const json = asts.map((a) => JSON.stringify(M.compact(a)));
  const revived = json.map((j) => M.Ast.fromJSON(j));
  const trees = revived.map((a) => M.transform(a, markdocConfig));
  // Prepared once, then spread per call the way the portal adds variables.
  const prepared = M.prepareConfig ? M.prepareConfig(markdocConfig) : undefined;
  return {
    M, config: markdocConfig, prepared, components, tk, direct, sources, parseArgs,
    tokens, asts, json, revived, trees,
  };
}

/** One full pass of a stage over the corpus. */
export function stageFn(name, s) {
  const { M } = s;
  switch (name) {
    case 'source → AST':
      return () => { for (const x of s.sources) s.direct(x); };
    case 'tokenize':
      return () => { for (const x of s.sources) s.tk.tokenize(x); };
    case 'parse (tokens)':
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
