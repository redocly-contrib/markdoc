// Experiment: what does it cost to keep mergeConfig's exact semantics while
// caching it? Merging the corpus config spreads ~140 schemas into fresh
// objects on every transform/validate call.
//
//   spread          what 0.6.4 does on every call
//   cache           reuse the merged objects keyed by the identity of
//                   config.tags/nodes/functions (no staleness check)
//   cache+check     ... and verify on every call that each key of the user's
//                   object and of the built-ins still maps to the same schema
//                   and that the key counts still match (catches in-place
//                   additions, removals and replacements on either side)
import { loadMarkdoc, prepare } from './lib/pipeline.mjs';
import { compare, report } from './lib/harness.mjs';

const M = loadMarkdoc('candidate');
const s = prepare(M, 'descriptions');

const spreadMerge = (config) => ({
  ...config,
  tags: { ...M.tags, ...config.tags },
  nodes: { ...M.nodes, ...config.nodes },
  functions: { ...M.functions, ...config.functions },
});

function countKeys(o) {
  let n = 0;
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
  return n;
}

function makeCache(check) {
  const caches = { tags: new WeakMap(), nodes: new WeakMap(), functions: new WeakMap() };
  const NONE = {};
  function merged(kind, builtins, custom = NONE) {
    const cache = caches[kind];
    const hit = cache.get(custom);
    if (hit && (!check || fresh(hit, builtins, custom))) return hit.merged;
    const value = { ...builtins, ...custom };
    cache.set(custom, { merged: value, count: countKeys(value) });
    return value;
  }
  function fresh({ merged, count }, builtins, custom) {
    for (const k in custom)
      if (Object.prototype.hasOwnProperty.call(custom, k) && merged[k] !== custom[k]) return false;
    for (const k in builtins)
      if (
        Object.prototype.hasOwnProperty.call(builtins, k) &&
        !Object.prototype.hasOwnProperty.call(custom, k) &&
        merged[k] !== builtins[k]
      )
        return false;
    return countKeys(merged) === count && countKeys({ ...builtins, ...custom }) === count;
  }
  return (config) => ({
    ...config,
    tags: merged('tags', M.tags, config.tags),
    nodes: merged('nodes', M.nodes, config.nodes),
    functions: merged('functions', M.functions, config.functions),
  });
}

// "cache+check" above recomputes the union count by spreading, which defeats
// the point; this one compares counts without building anything.
function makeCheapCheck() {
  const cache = new WeakMap();
  const NONE = {};
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function merged(builtins, custom = NONE) {
    let hit = cache.get(custom);
    if (hit && hit.builtins === builtins) {
      let ok = true;
      let n = 0;
      for (const k in custom) if (own(custom, k)) { n++; if (hit.merged[k] !== custom[k]) { ok = false; break; } }
      if (ok) for (const k in builtins) if (own(builtins, k) && !own(custom, k)) { n++; if (hit.merged[k] !== builtins[k]) { ok = false; break; } }
      if (ok && n === hit.count && countKeys(hit.merged) === n) return hit.merged;
    }
    const value = { ...builtins, ...custom };
    cache.set(custom, (hit = { builtins, merged: value, count: countKeys(value) }));
    return value;
  }
  return (config) => ({
    ...config,
    tags: merged(M.tags, config.tags),
    nodes: merged(M.nodes, config.nodes),
    functions: merged(M.functions, config.functions),
  });
}

const variants = {
  spread: spreadMerge,
  cache: makeCache(false),
  'cache+cheap check': makeCheapCheck(),
};

// Per call, as the portal calls it: a fresh options object around shared schemas.
const calls = s.revived.map(() => ({ ...s.config, variables: {} }));
report(
  `mergeConfig, ${calls.length} calls with ${Object.keys(s.config.tags).length} custom tags`,
  compare(
    Object.fromEntries(
      Object.entries(variants).map(([n, f]) => [n, () => { for (const c of calls) f(c); }])
    ),
    { rounds: 11, warmup: 3 }
  )
);

// And the end-to-end effect on transform: merge with each variant, then
// resolve + transform with the merged config.
report(
  'transform (descriptions) with each mergeConfig',
  compare(
    Object.fromEntries(
      Object.entries(variants).map(([n, f]) => [
        n,
        () => { for (let i = 0; i < calls.length; i++) { const c = f(calls[i]); s.revived[i].resolve(c).transform(c); } },
      ])
    ),
    { rounds: 11, warmup: 3 }
  )
);
