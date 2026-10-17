// Differential fuzzing: fastParse against Tokenizer + parse on random
// documents built from markdown edge cases.
//
//   node bench/fuzz-fastparse.mjs [iterations] [seed]
//
// Every mismatch is printed with its seed and source, minimized by dropping
// lines while the mismatch persists.
import { loadMarkdoc } from './lib/pipeline.mjs';

const M = loadMarkdoc('candidate');
const iterations = Number(process.argv[2] || 20000);
let seed = Number(process.argv[3] || 1);

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
  'word', 'two words', ' ', '  ', '\t', '*', '**', '***', '_', '__', '~~', '~', '~~~',
  '`', '``', '`code`', '``a`b``', '[', ']', '(', ')', '[link](/url)', '[a](<b c> "t")',
  '![img](/i.png)', '![a *b*](/x "y")', '[ref]', '[ref][]', '[x][ref]', '<https://a.b/c>',
  '<a@b.co>', '<b>', '</b>', '<!-- c -->', '<!--', '-->', '&amp;', '&#35;', '&#x41;', '&nope;',
  '\\*', '\\', '\\[', '{% $var %}', '{% $a.b %}', '{% tag %}', '{% /tag %}', '{% tag /%}',
  '{% .cls %}', '{% #id %}', '{% foo x=1 %}', '{% bad "unterminated %}', '{%', '%}',
  '{% if $x %}', '{% /if %}', '{% else /%}', '{% slot "s" %}', '{% /slot %}', 'http://x.y/{% $v %}',
  '«', '—', '“q”', 'ä', '🙂', '.', ',', '!', '?', ':', ';', '"', "'", '|', '\\|', '#', '-', '+',
  'a*b*c', '*a **b** c*', '_a_b_', '**a*', '*a**', '~~a~~', '~~~a~~~', 'x~~y', '***a***',
];
const BLOCK_PREFIX = [
  '', '', '', '', '# ', '## ', '###### ', '####### ', '#', '> ', '>', '> > ', '- ', '* ', '+ ',
  '1. ', '2) ', '10. ', '0. ', '  - ', '    ', '\t', '   > ', '- [ ] ', '> - ', '- > ',
  '    - ', '  1. ', '   ',
];
const WHOLE_LINES = [
  '', '', '', '---', '***', '___', '- - -', '```', '```js', '``` js {% .c %}', '~~~', '````',
  '```{% process=false %}', '| a | b |', '|---|:-:|', '| 1 | 2 |', 'a | b', '--- | ---',
  '|:--|--:|', '[ref]: /url "title"', '[ref]: <x y>', '[Ref]:\n/url', '<div>', '</div>',
  '<script>', '</script>', '<!-- block', 'comment -->', '<?php ?>', '<![CDATA[ x ]]>',
  '{% tag %}', '{% /tag %}', '{% tag /%}', '{% callout type="note" %}', '{% /callout %}',
  '{% if $x %}', '{% else /%}', '{% /if %}', '{% table %}', '{% /table %}', '{% .x %}',
  '{% partial file="a.md" /%}', '{%\n  tag\n%}', '{% $v %}', '{% f(1) %}', '{% tag "unclosed',
  '> [!NOTE]', '> [!TIP]  ', '> [!WARNING]\n> body', '> [!bogus]', '[!NOTE]',
  '---\ntitle: x\n---', '  ', '\t', 'text  ', 'text\\', 'line\r', '\0',
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

const CONFIGS = [
  [{}, undefined],
  [{}, { compact: true }],
  [{ html: true, allowIndentation: true, allowComments: true }, undefined],
  [{ html: true, allowIndentation: true, allowComments: true }, { slots: true, compact: true }],
  [{ allowLinkValidation: true, githubAdmonitions: false }, { file: 'f.md' }],
];

function outcome(fn) {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return `THREW ${e && e.constructor && e.constructor.name}`;
  }
}

const tokenizers = CONFIGS.map(([cfg]) => new M.Tokenizer(cfg));
function mismatch(src, k) {
  const [cfg, args] = CONFIGS[k];
  return outcome(() => M.parse(tokenizers[k].tokenize(src), args)) !==
    outcome(() => M.fastParse(src, cfg, args));
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
  const src = doc();
  for (let k = 0; k < CONFIGS.length; k++) {
    if (!mismatch(src, k)) continue;
    failures++;
    const small = minimize(src, k);
    console.log(`\n✗ iteration ${it} config ${JSON.stringify(CONFIGS[k])}\n${JSON.stringify(small)}`);
    const [cfg, args] = CONFIGS[k];
    console.log('  tokens:', outcome(() => M.parse(tokenizers[k].tokenize(small), args)).slice(0, 600));
    console.log('  fast:  ', outcome(() => M.fastParse(small, cfg, args)).slice(0, 600));
    if (failures >= 8) process.exit(1);
    break;
  }
}
console.log(`\n${iterations} random documents x ${CONFIGS.length} settings (seed ${startSeed}): ${failures} mismatches`);
if (failures) process.exitCode = 1;
