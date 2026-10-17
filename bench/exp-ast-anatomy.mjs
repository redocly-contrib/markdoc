// Experiment: what are the bytes of a stored (compact()ed) AST made of?
//
// Attributes every byte of the serialized JSON to the field that produced it,
// so a format change can target what actually dominates.
import { loadMarkdoc, prepare } from './lib/pipeline.mjs';
import { fmtBytes } from './lib/harness.mjs';
import zlib from 'node:zlib';

const M = loadMarkdoc('candidate');

function anatomy(json) {
  const bytes = new Map();
  const counts = new Map();
  const add = (k, n) => bytes.set(k, (bytes.get(k) || 0) + n);
  const len = (v) => JSON.stringify(v).length;

  function visitNode(n) {
    counts.set(n.type, (counts.get(n.type) || 0) + 1);
    // Structural overhead: braces, commas, the "$$mdtype":"Node" pair, key names.
    add('$$mdtype:"Node"', len('$$mdtype') + 1 + len('Node') + 1);
    add('"type" key+value', len('type') + 1 + len(n.type) + 1);
    add('{} and commas', 2);
    if (n.tag !== undefined)
      add('"tag" key+value', len('tag') + 1 + len(n.tag) + 1);
    if (n.inline) add('"inline":true', len('inline') + 1 + 4 + 1);
    if (n.location) add('location', len('location') + 1 + len(n.location) + 1);
    if (n.errors) add('errors', len('errors') + 1 + len(n.errors) + 1);
    if (n.annotations)
      add('annotations', len('annotations') + 1 + len(n.annotations) + 1);

    const attrs = n.attributes;
    const keys = Object.keys(attrs);
    add('"attributes" key + {}', len('attributes') + 1 + 2 + 1);
    for (const k of keys) {
      const v = attrs[k];
      const key = len(k) + 1 + (keys.length > 1 ? 1 : 0);
      if (k === 'content' && typeof v === 'string') {
        add('text content: quotes/escapes', len(v) - v.length);
        add('text content: characters', v.length);
        add('attribute keys', key);
      } else {
        add('other attribute values', len(v));
        add('attribute keys', key);
      }
    }
    add(
      '"children" key + []',
      len('children') + 1 + 2 + 1 + Math.max(0, n.children.length - 1)
    );
    for (const c of n.children) visitNode(c);
    if (n.slots) {
      add('slots', len('slots') + 3);
      for (const s of Object.values(n.slots)) visitNode(s);
    }
  }

  let total = 0;
  for (const j of json) {
    total += j.length;
    const root = JSON.parse(j);
    for (const r of Array.isArray(root) ? root : [root]) visitNode(r);
  }
  return { bytes, counts, total };
}

for (const corpusName of ['pages', 'descriptions']) {
  const s = prepare(M, corpusName);
  const sourceBytes = s.sources.reduce((n, x) => n + Buffer.byteLength(x), 0);
  const { bytes, counts, total } = anatomy(s.json);
  const all = Buffer.from(s.json.join('\n'));
  console.log(
    `\n${corpusName}: source ${fmtBytes(sourceBytes)}, stored JSON ${fmtBytes(
      total
    )} ` +
      `(${(total / sourceBytes).toFixed(1)}x source); gzip ${fmtBytes(
        zlib.gzipSync(all).length
      )}, ` +
      `brotli ${fmtBytes(zlib.brotliCompressSync(all).length)}`
  );
  const accounted = [...bytes.values()].reduce((a, b) => a + b, 0);
  for (const [k, v] of [...bytes].sort((a, b) => b[1] - a[1]))
    console.log(
      `  ${k.padEnd(34)}${fmtBytes(v).padStart(10)}  ${((v / total) * 100)
        .toFixed(1)
        .padStart(5)}%`
    );
  console.log(
    `  ${'(accounted)'.padEnd(34)}${fmtBytes(accounted).padStart(10)}`
  );
  const nodes = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`  nodes: ${nodes}  (${(total / nodes).toFixed(0)} bytes/node)`);
  console.log(
    '  by type: ' +
      [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([t, c]) => `${t} ${c}`)
        .join(', ')
  );
}
