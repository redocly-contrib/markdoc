// Experiment: how fast are other markdown engines on the same corpus?
//
//   NODE_ENV=production node --expose-gc bench/exp-engines.mjs [pages|descriptions]
//
// Each engine runs in its own process (no shared JIT state), CPU time, median
// of rounds. Two kinds of task:
//
//   tree  parse into a JS tree you could transform — the job Markdoc's
//         tokenize+parse does. For WASM engines this includes materializing
//         the tree as JS objects.
//   html  markdown straight to an HTML string — a lower bound for engines
//         that never hand a tree to JS.
//
// None of these engines understands Markdoc's {% tag %} syntax: they see tags
// as text. So these are upper bounds for the CommonMark core only; the tag
// layer would still have to be added on top (Markdoc adds it as
// markdown-it plugins today).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './lib/corpus.mjs';
import { compare, fmtMs } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);

const ENGINES = {
  'markdoc 0.6.4: tokenize+parse': async () => {
    const M = require('markdoc-baseline');
    const tk = new M.Tokenizer({
      html: true,
      allowIndentation: true,
      allowComments: true,
    });
    return { kind: 'tree', run: (s) => M.parse(tk.tokenize(s)) };
  },
  'markdoc branch: new parser (source → AST)': async () => {
    const M = require('../dist/index.js');
    const config = { html: true, allowIndentation: true, allowComments: true };
    return { kind: 'tree', run: (s) => M.parse(s, config) };
  },
  'markdown-it 12.3 (no markdoc plugins)': async () => {
    const MarkdownIt = require('markdown-it');
    const md = new MarkdownIt({ html: true });
    return { kind: 'tokens', run: (s) => md.parse(s, {}) };
  },
  'markdown-it 15.0 (no markdoc plugins)': async () => {
    const MarkdownIt = require('markdown-it-15');
    const md = new MarkdownIt({ html: true });
    return { kind: 'tokens', run: (s) => md.parse(s, {}) };
  },
  'marked 18: lexer': async () => {
    const { marked } = await import('marked');
    return { kind: 'tokens', run: (s) => marked.lexer(s) };
  },
  'mdastic 0.1 (gfm, no positions)': async () => {
    const { parse } = await import('mdastic');
    const { gfm } = await import('mdastic/gfm');
    const syntax = [gfm()];
    return { kind: 'tree', run: (s) => parse(s, { syntax, positions: false }) };
  },
  'mdastic 0.1 (gfm, positions)': async () => {
    const { parse } = await import('mdastic');
    const { gfm } = await import('mdastic/gfm');
    const syntax = [gfm()];
    return { kind: 'tree', run: (s) => parse(s, { syntax }) };
  },
  'mdast-util-from-markdown 2 (remark)': async () => {
    const { fromMarkdown } = await import('mdast-util-from-markdown');
    return { kind: 'tree', run: (s) => fromMarkdown(s) };
  },
  'commonmark.js 0.31': async () => {
    const { Parser } = require('commonmark');
    const p = new Parser();
    return { kind: 'tree', run: (s) => p.parse(s) };
  },
  'comrak 0.48 wasm: parseMarkdown (Rust)': async () => {
    const { parseMarkdown } = await import('comrak');
    const options = {
      extension: { table: true, strikethrough: true },
      render: { unsafe: true },
    };
    return { kind: 'tree', run: (s) => parseMarkdown(s, options) };
  },
  'comrak 0.48 wasm: to HTML (Rust)': async () => {
    const { markdownToHTML } = await import('comrak');
    const options = {
      extension: { table: true, strikethrough: true },
      render: { unsafe: true },
    };
    return { kind: 'html', run: (s) => markdownToHTML(s, options) };
  },
  'pulldown-cmark wasm: to HTML (Rust)': async () => {
    const { format } = require('pulldown-cmark-wasm');
    return { kind: 'html', run: (s) => format(s) };
  },
  'markdown-wasm (md4c, C): to HTML': async () => {
    const md = require('markdown-wasm');
    await md.ready;
    return { kind: 'html', run: (s) => md.parse(s) };
  },
  'markdown-it 15.0: to HTML': async () => {
    const MarkdownIt = require('markdown-it-15');
    const md = new MarkdownIt({ html: true });
    return { kind: 'html', run: (s) => md.render(s) };
  },
  'marked 18: to HTML': async () => {
    const { marked } = await import('marked');
    return { kind: 'html', run: (s) => marked.parse(s, { async: false }) };
  },
  'micromark 4: to HTML': async () => {
    const { micromark } = await import('micromark');
    return {
      kind: 'html',
      run: (s) => micromark(s, { allowDangerousHtml: true }),
    };
  },
};

const [, , corpusName = 'pages', engineName] = process.argv;

if (engineName) {
  // Worker: time one engine.
  const corpus = loadCorpus();
  const sources =
    corpusName === 'pages'
      ? corpus.pages.map((p) => p.source)
      : corpus.descriptions;
  const { kind, run } = await ENGINES[engineName]();
  const r = compare(
    {
      x: () => {
        for (const s of sources) run(s);
      },
    },
    { rounds: 7, warmup: 2 }
  );
  process.stdout.write(JSON.stringify({ kind, ms: r.x.cpu.median }));
} else {
  const rows = [];
  for (const name of Object.keys(ENGINES)) {
    const p = spawnSync(
      process.execPath,
      ['--expose-gc', self, corpusName, name],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      }
    );
    if (p.status !== 0) {
      console.log(
        `  ${name}: FAILED\n${p.stderr.split('\n').slice(0, 6).join('\n')}`
      );
      continue;
    }
    rows.push({ name, ...JSON.parse(p.stdout) });
  }
  const ref = rows.find((r) => r.name.startsWith('markdoc 0.6.4'))?.ms;
  console.log(
    `\n${corpusName.toUpperCase()} — engine comparison (CPU, median)`
  );
  console.log(
    '  engine'.padEnd(44) +
      'kind'.padEnd(8) +
      'time'.padStart(10) +
      '   vs markdoc 0.6.4 tokenize+parse'
  );
  for (const r of rows)
    console.log(
      `  ${r.name}`.padEnd(44) +
        r.kind.padEnd(8) +
        fmtMs(r.ms).padStart(10) +
        `   ${(ref / r.ms).toFixed(2)}x`
    );
  if (process.env.EXP_JSON)
    (await import('node:fs')).writeFileSync(
      process.env.EXP_JSON,
      JSON.stringify(rows, null, 2)
    );
}
