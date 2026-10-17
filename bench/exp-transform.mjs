// Experiment: where does Markdoc.transform's time go, and what would skipping
// each piece buy? Runs against the candidate build (dist).
//
//   full              Markdoc.transform(ast, config)  (mergeConfig + resolve clone + transform)
//   premerged         config merged once up front; resolve clone + transform per doc
//   premerged+noclone config merged once; transform the revived tree directly —
//                     only valid when the tree holds no variables or functions,
//                     which is true for this whole corpus (checked below)
//   premerged+share   config merged once; a structural-sharing resolve that
//                     returns the original node when nothing under it changes
import { loadMarkdoc, prepare } from './lib/pipeline.mjs';
import { compare, report } from './lib/harness.mjs';

const M = loadMarkdoc('candidate');
const { Node } = M.Ast;

function mergeConfig(config = {}) {
  return {
    ...config,
    tags: { ...M.tags, ...config.tags },
    nodes: { ...M.nodes, ...config.nodes },
    functions: { ...M.functions, ...config.functions },
  };
}

// Returns the same value when nothing inside it resolves to something new.
function resolveShared(value, config) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Node) return resolveNodeShared(value, config);
  if (Array.isArray(value)) {
    let out;
    for (let i = 0; i < value.length; i++) {
      const r = resolveShared(value[i], config);
      if (r !== value[i]) (out ??= value.slice())[i] = r;
    }
    return out ?? value;
  }
  if (M.Ast.isAst(value) && value.resolve instanceof Function)
    return value.resolve(config);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let out;
  for (const k of Object.keys(value)) {
    const r = resolveShared(value[k], config);
    if (r !== value[k]) (out ??= { ...value })[k] = r;
  }
  return out ?? value;
}

function resolveNodeShared(node, config) {
  const children = resolveShared(node.children, config);
  const attributes = resolveShared(node.attributes, config);
  let slots = node.slots;
  for (const name of Object.keys(node.slots ?? {})) {
    const r = resolveNodeShared(node.slots[name], config);
    if (r !== node.slots[name])
      (slots === node.slots ? (slots = { ...slots }) : slots)[name] = r;
  }
  if (
    children === node.children &&
    attributes === node.attributes &&
    slots === node.slots
  )
    return node;
  return Object.assign(new Node(), node, { children, attributes, slots });
}

function hasAstValues(node) {
  for (const n of [node, ...node.walk()])
    for (const v of M.Ast.getAstValues(n.attributes)) return true;
  return false;
}

for (const corpusName of ['pages', 'descriptions']) {
  const s = prepare(M, corpusName);
  const merged = mergeConfig(s.config);
  const withAst = s.revived.filter(hasAstValues).length;
  console.log(
    `\n${corpusName}: ${withAst} of ${s.revived.length} docs contain variables/functions`
  );

  // Same output for every variant.
  for (const a of s.revived) {
    const ref = JSON.stringify(M.transform(a, s.config));
    if (JSON.stringify(a.resolve(merged).transform(merged)) !== ref)
      throw new Error('premerged');
    if (JSON.stringify(resolveNodeShared(a, merged).transform(merged)) !== ref)
      throw new Error('share');
  }

  const r = compare(
    {
      full: () => {
        for (const a of s.revived) M.transform(a, s.config);
      },
      'mergeConfig only': () => {
        for (let i = 0; i < s.revived.length; i++) mergeConfig(s.config);
      },
      premerged: () => {
        for (const a of s.revived) a.resolve(merged).transform(merged);
      },
      'premerged+share': () => {
        for (const a of s.revived)
          resolveNodeShared(a, merged).transform(merged);
      },
      'premerged+noclone': () => {
        for (const a of s.revived) a.transform(merged);
      },
    },
    { rounds: 11, warmup: 3 }
  );
  report(`${corpusName} — transform breakdown`, r);
}
