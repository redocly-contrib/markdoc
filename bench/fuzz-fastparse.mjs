// Differential fuzzing: the parser against published 0.6.4 on random
// documents built from markdown edge cases.
//
//   node bench/fuzz-fastparse.mjs [iterations] [seed] [random|mutate]
//
// random: documents assembled from markdown edge-case fragments
// mutate: real corpus documents with lines dropped, duplicated, re-indented
//         or split, and edge-case characters spliced in
//
// Every mismatch is printed with its seed and source, minimized by dropping
// lines while the mismatch persists.
import { loadMarkdoc } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const M = loadMarkdoc('candidate');
// Published 0.6.4 is the reference: markdown-it plus Markdoc's tokenizer plugins.
const B = loadMarkdoc('baseline');
const iterations = Number(process.argv[2] || 20000);
let seed = Number(process.argv[3] || 1);
const strategy = process.argv[4] || 'random';
const corpusDocs =
  strategy === 'mutate'
    ? (() => {
        const c = loadCorpus();
        return [...c.pages.map((p) => p.source), ...c.descriptions];
      })()
    : [];

function rng() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rng() * a.length)];

const INLINE = [
  'word',
  'two words',
  ' ',
  '  ',
  '\t',
  '*',
  '**',
  '***',
  '_',
  '__',
  '~~',
  '~',
  '~~~',
  '`',
  '``',
  '`code`',
  '``a`b``',
  '[',
  ']',
  '(',
  ')',
  '[link](/url)',
  '[a](<b c> "t")',
  '![img](/i.png)',
  '![a *b*](/x "y")',
  '[ref]',
  '[ref][]',
  '[x][ref]',
  '<https://a.b/c>',
  '<a@b.co>',
  '<b>',
  '</b>',
  '<!-- c -->',
  '<!--',
  '-->',
  '&amp;',
  '&#35;',
  '&#x41;',
  '&nope;',
  '\\*',
  '\\',
  '\\[',
  '{% $var %}',
  '{% $a.b %}',
  '{% tag %}',
  '{% /tag %}',
  '{% tag /%}',
  '{% .cls %}',
  '{% #id %}',
  '{% foo x=1 %}',
  '{% bad "unterminated %}',
  '{%',
  '%}',
  '{% if $x %}',
  '{% /if %}',
  '{% else /%}',
  '{% slot "s" %}',
  '{% /slot %}',
  'http://x.y/{% $v %}',
  '[a]',
  '[a][]',
  '[b][a]',
  '[e]',
  '«',
  '—',
  '“q”',
  'ä',
  '🙂',
  '.',
  ',',
  '!',
  '?',
  ':',
  ';',
  '"',
  "'",
  '|',
  '\\|',
  '#',
  '-',
  '+',
  'a*b*c',
  '*a **b** c*',
  '_a_b_',
  '**a*',
  '*a**',
  '~~a~~',
  '~~~a~~~',
  'x~~y',
  '***a***',
];
const BLOCK_PREFIX = [
  '',
  '',
  '',
  '',
  '# ',
  '## ',
  '###### ',
  '####### ',
  '#',
  '> ',
  '>',
  '> > ',
  '- ',
  '* ',
  '+ ',
  '1. ',
  '2) ',
  '10. ',
  '0. ',
  '  - ',
  '    ',
  '\t',
  '   > ',
  '- [ ] ',
  '> - ',
  '- > ',
  '    - ',
  '  1. ',
  '   ',
];
const WHOLE_LINES = [
  '',
  '',
  '',
  '---',
  '***',
  '___',
  '- - -',
  '```',
  '```js',
  '``` js {% .c %}',
  '~~~',
  '````',
  '```{% process=false %}',
  '| a | b |',
  '|---|:-:|',
  '| 1 | 2 |',
  'a | b',
  '--- | ---',
  '|:--|--:|',
  '[ref]: /url "title"',
  '[ref]: <x y>',
  '[Ref]:\n/url',
  '<div>',
  '</div>',
  '<script>',
  '</script>',
  '<!-- block',
  'comment -->',
  '<?php ?>',
  '<![CDATA[ x ]]>',
  '{% tag %}',
  '{% /tag %}',
  '{% tag /%}',
  '{% callout type="note" %}',
  '{% /callout %}',
  '{% if $x %}',
  '{% else /%}',
  '{% /if %}',
  '{% table %}',
  '{% /table %}',
  '{% .x %}',
  '{% partial file="a.md" /%}',
  '{%\n  tag\n%}',
  '{% $v %}',
  '{% f(1) %}',
  '{% tag "unclosed',
  '> [!NOTE]',
  '> [!TIP]  ',
  '> [!WARNING]\n> body',
  '> [!bogus]',
  '[!NOTE]',
  '[a]: /u',
  '[a]: /u "t"',
  '[a]:\n/u',
  '[a]: /u\n"t"',
  '[a]: /u\n"multi',
  'line"',
  "'t'",
  '(t)',
  '"t"',
  '"unclosed',
  '[a\nb]: /x',
  '[b]: <x y> (t)',
  '[c]: /u "t" junk',
  '[d]: /u "t"\n# h',
  '[e]:',
  '[ref]: /x\n[ref2]: /y\n[ref3]: /z',
  '> [q]: /x',
  '- [l]: /x',
  '[\\]]: /x',
  '[ ]: /x',
  '---\ntitle: x\n---',
  '  ',
  '\t',
  'text  ',
  'text\\',
  'line\r',
  '\0',
];

function inline() {
  let s = '';
  const n = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) s += pick(INLINE) + (rng() < 0.4 ? ' ' : '');
  return s;
}

function doc() {
  const lines = [];
  const n = 1 + Math.floor(rng() * 14);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.35) lines.push(pick(WHOLE_LINES));
    else lines.push(pick(BLOCK_PREFIX) + inline());
  }
  let s = lines.join(rng() < 0.1 ? '\r\n' : '\n');
  if (rng() < 0.2) s += '\n';
  if (rng() < 0.05) s = '  \n' + s;
  return s;
}

const SPLICE = [
  '*',
  '_',
  '`',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '{%',
  '%}',
  '"',
  '|',
  '\\',
  '\t',
  '    ',
  '\n',
  '\n\n',
  '- ',
  '> ',
  '1. ',
  '#',
  '!',
  '&',
  '~~',
  '{% /',
  '<!--',
  '-->',
  '---',
  '```',
];

function mutate() {
  const lines = pick(corpusDocs).split('\n');
  // Work on a window so documents stay small enough to minimize quickly.
  const start = Math.floor(rng() * Math.max(1, lines.length - 40));
  const window = lines.slice(start, start + 1 + Math.floor(rng() * 40));
  const edits = 1 + Math.floor(rng() * 6);
  for (let e = 0; e < edits; e++) {
    const i = Math.floor(rng() * window.length);
    switch (Math.floor(rng() * 6)) {
      case 0:
        window.splice(i, 1);
        break;
      case 1:
        window.splice(i, 0, window[i] ?? '');
        break;
      case 2:
        window[i] =
          pick(['', ' ', '  ', '   ', '    ', '\t', '> ', '- ']) +
          (window[i] ?? '');
        break;
      case 3:
        window[i] = (window[i] ?? '').replace(/^\s+/, '');
        break;
      case 4: {
        const line = window[i] ?? '';
        const at = Math.floor(rng() * (line.length + 1));
        window[i] = line.slice(0, at) + pick(SPLICE) + line.slice(at);
        break;
      }
      case 5:
        window.splice(i, 0, '');
        break;
    }
  }
  return window.join('\n');
}

const CONFIGS = [
  [{}, undefined],
  [{}, { compact: true }],
  [{ html: true, allowIndentation: true, allowComments: true }, undefined],
  [
    { html: true, allowIndentation: true, allowComments: true },
    { slots: true, compact: true },
  ],
  [{ allowLinkValidation: true, githubAdmonitions: false }, { file: 'f.md' }],
];

function outcome(fn) {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return `THREW ${e && e.constructor && e.constructor.name}`;
  }
}

const tokenizers = CONFIGS.map(([cfg]) => new B.Tokenizer(cfg));
const viaReference = (src, k) =>
  outcome(() => B.parse(tokenizers[k].tokenize(src), CONFIGS[k][1]));
const viaParser = (src, k) =>
  outcome(() => M.parse(src, { ...CONFIGS[k][1], ...CONFIGS[k][0] }));
// With comments on, 0.6.4 loops forever on a comment that a link label scan
// reaches (`[<!--x-->](/u)`); the parser does not, and tests that itself. Skip
// a paragraph with a `[` before a comment there.
const hangsReference = (src, k) =>
  CONFIGS[k][0].allowComments &&
  src.split(/\n[ \t]*\n/).some((block) => /\[[^]*<!--[^]*-->/.test(block));

// Where 0.6.4 itself throws (an unclosed inline tag in link text), the parser
// returns an AST instead, so those inputs have nothing to compare.
function mismatch(src, k) {
  if (hangsReference(src, k)) return false;
  const expected = viaReference(src, k);
  return !expected.startsWith('THREW') && expected !== viaParser(src, k);
}

function minimize(src, k) {
  let lines = src.split('\n');
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      const next = lines.slice(0, i).concat(lines.slice(i + 1));
      if (next.length && mismatch(next.join('\n'), k)) {
        lines = next;
        changed = true;
        i--;
      }
    }
  }
  return lines.join('\n');
}

let failures = 0;
const startSeed = seed;
for (let it = 0; it < iterations; it++) {
  const src = strategy === 'mutate' ? mutate() : doc();
  for (let k = 0; k < CONFIGS.length; k++) {
    if (!mismatch(src, k)) continue;
    failures++;
    const small = minimize(src, k);
    console.log(
      `\n✗ iteration ${it} config ${JSON.stringify(
        CONFIGS[k]
      )}\n${JSON.stringify(small)}`
    );
    console.log('  0.6.4: ', viaReference(small, k).slice(0, 600));
    console.log('  branch:', viaParser(small, k).slice(0, 600));
    if (failures >= 8) process.exit(1);
    break;
  }
}
console.log(
  `\n${iterations} ${strategy} documents x ${CONFIGS.length} settings (seed ${startSeed}): ${failures} mismatches`
);
if (failures) process.exitCode = 1;
