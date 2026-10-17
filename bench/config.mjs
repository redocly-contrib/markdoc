// A realistic Markdoc config for the corpus.
//
// The real Realm schemas pull in React components and resolvers, so instead
// every tag the corpus actually uses gets a schema that renders to a component
// name and declares every attribute the corpus passes to it. That gives the
// transformer the same per-node work as production — a schema lookup and one
// pass per declared attribute — without depending on the theme package.

const BUILT_INS = new Set(['if', 'else', 'table', 'partial', 'slot', 'comment']);

function pascal(name) {
  return name.replace(/(^|[-_])([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}

export function buildConfig(Markdoc, pages) {
  const attrsByTag = new Map();

  for (const { source } of pages) {
    const ast = Markdoc.parse(source);
    for (const node of ast.walk()) {
      if (node.type !== 'tag' || !node.tag || BUILT_INS.has(node.tag)) continue;
      if (!attrsByTag.has(node.tag)) attrsByTag.set(node.tag, new Set());
      const set = attrsByTag.get(node.tag);
      for (const key of Object.keys(node.attributes)) set.add(key);
    }
  }

  const tags = {};
  for (const [tag, attrs] of attrsByTag) {
    tags[tag] = {
      render: pascal(tag),
      attributes: Object.fromEntries([...attrs].map((a) => [a, {}])),
    };
  }

  return { tags, variables: {}, partials: {} };
}

/** A trivial React component for every custom tag, so the React renderer has
 *  something real to resolve each component name to. */
export function buildComponents(config) {
  const Stub = (props) => props.children ?? null;
  return Object.fromEntries(
    Object.values(config.tags).map((schema) => [schema.render, Stub])
  );
}
