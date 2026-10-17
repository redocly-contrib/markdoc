// parseFirstHeading: the first heading without parsing the whole document.
//
//   NODE_ENV=production node --expose-gc bench/exp-first-heading.mjs
//
// check: for every corpus document, parseFirstHeading(source, options) must
//        return the node findFirstHeading(parse(source, options), skip) does.
// time:  CPU time per corpus pass, each variant in its own process:
//          0.6.4 tokenizeUntil   what Realm does today: tokenizeUntil with a
//                                slot-aware heading predicate, parse the tokens
//          full parse + find     parse(source) then findFirstHeading
//          parseFirstHeading     the early-stopping parse
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMarkdoc } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';
import { compare, fmtMs } from './lib/harness.mjs';

const self = fileURLToPath(import.meta.url);
const OPTIONS = { html: true, allowIndentation: true, allowComments: true, slots: true };
const [, , mode, variant] = process.argv;

function sources() {
  const { pages } = loadCorpus();
  return pages.map((p) => p.source);
}

if (mode === 'worker') {
  const docs = sources();
  let run;
  if (variant === '0.6.4 tokenizeUntil') {
    const B = loadMarkdoc('baseline');
    const tokenizer = new B.Tokenizer(OPTIONS);
    const find = (node) => {
      for (const child of node.children) {
        if (child.type === 'heading') return child;
        const found = find(child);
        if (found) return found;
      }
    };
    run = (src) => {
      const tokens = tokenizer.tokenizeUntil(src, () => {
        let slotDepth = 0;
        return (token) => {
          if (token.meta?.tag === 'slot') slotDepth += token.nesting;
          return token.type === 'heading_close' && slotDepth === 0;
        };
      });
      return find(B.parse(tokens, { slots: true }));
    };
  } else {
    const M = loadMarkdoc('candidate');
    run =
      variant === 'full parse + find'
        ? (src) => M.findFirstHeading(M.parse(src, OPTIONS))
        : (src) => M.parseFirstHeading(src, OPTIONS);
  }
  const r = compare({ x: () => { for (const s of docs) run(s); } }, { rounds: 9, warmup: 3 });
  process.stdout.write(JSON.stringify({ ms: r.x.cpu.median }));
} else {
  // Correctness, in-process.
  const M = loadMarkdoc('candidate');
  const docs = sources();
  const { descriptions } = loadCorpus();
  const tagCounts = new Map();
  for (const s of docs)
    for (const node of M.parse(s, OPTIONS).walk())
      if (node.type === 'tag') tagCounts.set(node.tag, (tagCounts.get(node.tag) || 0) + 1);
  // Skip the most common tags, to exercise skipping on real content.
  const common = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const skipCommon = (tag) => common.includes(tag.tag);
  const skipByAttribute = (tag) => Object.keys(tag.attributes).length > 1;

  let failures = 0;
  for (const [label, list, options, skip] of [
    ['pages, portal settings + slots', docs, OPTIONS, undefined],
    ['pages, no slots', docs, { ...OPTIONS, slots: false }, undefined],
    [`pages, skipping ${common.join(', ')}`, docs, OPTIONS, skipCommon],
    ['pages, skipping tags with 2+ attributes', docs, OPTIONS, skipByAttribute],
    ['pages, defaults', docs, {}, undefined],
    ['pages, frontmatter off', docs, { ...OPTIONS, frontmatter: false }, undefined],
    ['descriptions, defaults', descriptions, {}, undefined],
  ]) {
    let bad = 0;
    let found = 0;
    for (let i = 0; i < list.length; i++) {
      const expected = JSON.stringify(M.findFirstHeading(M.parse(list[i], options), skip));
      const actual = JSON.stringify(M.parseFirstHeading(list[i], { ...options, skip }));
      if (expected !== undefined) found++;
      if (expected !== actual) {
        if (bad < 3) console.log(`  ✗ doc #${i}\n    full:  ${expected}\n    early: ${actual}`);
        bad++;
      }
    }
    failures += bad;
    console.log(`${bad ? '✗' : '✓'} ${label}: ${list.length - bad}/${list.length} identical (${found} have a heading)`);
  }

  // Speed, one process per variant, alternating.
  const VARIANTS = ['0.6.4 tokenizeUntil', 'full parse + find', 'parseFirstHeading'];
  const runs = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  for (let round = 0; round < 3; round++)
    for (const v of round % 2 ? [...VARIANTS].reverse() : VARIANTS) {
      const p = spawnSync(process.execPath, ['--expose-gc', self, 'worker', v], {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });
      if (p.status !== 0) throw new Error(p.stderr);
      runs[v].push(JSON.parse(p.stdout).ms);
    }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const ref = median(runs[VARIANTS[0]]);
  console.log(`\nfirst heading of all ${docs.length} pages (CPU, median of 3 processes)`);
  for (const v of VARIANTS) {
    const ms = median(runs[v]);
    console.log(`  ${v.padEnd(22)}${fmtMs(ms).padStart(10)}   ${(ref / ms).toFixed(2)}x vs 0.6.4`);
  }
  if (failures) process.exitCode = 1;
}
