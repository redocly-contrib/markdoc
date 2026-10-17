// Experiment: faster Ast.fromJSON.
//
// Baseline uses JSON.parse(text, reviver). A reviver disables V8's JSON fast
// path and is invoked for every value in the document — every string and
// number, not just nodes — which profiling showed is ~90% of revive time.
//
// Variants all keep the exact semantics (same classes, every own property
// copied, bottom-up), differing only in how a Node is materialized:
//   assign      JSON.parse + walk + Object.assign(new Node(), v)   (as today)
//   construct   JSON.parse + walk + new Node(type, attrs, children, tag) + assign rest
//   proto       JSON.parse + walk + Object.setPrototypeOf(v, Node.prototype) + defaults
import { createRequire } from 'node:module';
import { loadCorpus } from './lib/corpus.mjs';
import { buildConfig } from './lib/config.mjs';
import { compare, report } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const mod = require('markdoc-baseline');
const Markdoc = mod.default || mod;
const { Node, Variable, Function: Fn } = Markdoc.Ast;

function makeReviver(toNode) {
  return function revive(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const v = value[i];
        if (v !== null && typeof v === 'object') value[i] = revive(v);
      }
      return value;
    }
    for (const key in value) {
      const v = value[key];
      if (v !== null && typeof v === 'object') value[key] = revive(v);
    }
    switch (value.$$mdtype) {
      case 'Node': return toNode(value);
      case 'Variable': return Object.assign(new Variable(), value);
      case 'Function': return Object.assign(new Fn(), value);
      default: return value;
    }
  };
}

const viaAssign = makeReviver((v) => Object.assign(new Node(), v));
const viaConstruct = makeReviver((v) =>
  Object.assign(new Node(v.type, v.attributes, v.children, v.tag), v)
);
const viaProto = makeReviver((v) => {
  Object.setPrototypeOf(v, Node.prototype);
  if (v.inline === undefined) v.inline = false;
  if (v.errors === undefined) v.errors = [];
  if (v.annotations === undefined) v.annotations = [];
  if (v.slots === undefined) v.slots = {};
  return v;
});

const variants = {
  'baseline fromJSON (reviver)': (j) => Markdoc.Ast.fromJSON(j),
  'parse + assign': (j) => viaAssign(JSON.parse(j)),
  'parse + construct': (j) => viaConstruct(JSON.parse(j)),
  'parse + setPrototypeOf': (j) => viaProto(JSON.parse(j)),
};

const { pages, descriptions } = loadCorpus();
const config = buildConfig(Markdoc, pages);

for (const [label, sources, args] of [
  ['PAGES', pages.map((p) => p.source), undefined],
  ['DESCRIPTIONS', descriptions, { compact: true }],
]) {
  const json = sources.map((s) => JSON.stringify(Markdoc.compact(Markdoc.parse(s, args))));

  // Correctness: every variant must serialize back to the same JSON as
  // the baseline revival, and produce the same transform output.
  const ref = json.map((j) => Markdoc.Ast.fromJSON(j));
  for (const [name, fn] of Object.entries(variants)) {
    for (let i = 0; i < json.length; i++) {
      const got = fn(json[i]);
      if (JSON.stringify(got) !== JSON.stringify(ref[i]))
        throw new Error(`${name}: JSON mismatch on #${i}`);
      if (
        JSON.stringify(Markdoc.transform(got, config)) !==
        JSON.stringify(Markdoc.transform(ref[i], config))
      )
        throw new Error(`${name}: transform mismatch on #${i}`);
    }
  }

  report(
    `${label} — revive only`,
    compare(
      Object.fromEntries(
        Object.entries(variants).map(([n, fn]) => [n, () => { for (const j of json) fn(j); }])
      )
    )
  );

  // Downstream effect: does the revived shape make transform faster or slower?
  const revivedBy = Object.fromEntries(
    Object.entries(variants).map(([n, fn]) => [n, json.map((j) => fn(j))])
  );
  report(
    `${label} — transform of the revived tree`,
    compare(
      Object.fromEntries(
        Object.entries(revivedBy).map(([n, trees]) => [
          n,
          () => { for (const t of trees) Markdoc.transform(t, config); },
        ])
      )
    )
  );
}
