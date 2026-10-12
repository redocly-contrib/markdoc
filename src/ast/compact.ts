import Node from './node';

/**
 * Rewrites a parsed AST into the shape `parse(src, { compact: true })` would
 * have produced, for storing it as JSON.
 *
 * Engines have to parse with locations, because resolvers need them to report
 * problems and link ranges. Once resolution is done those locations, and the
 * implied `inline` wrapper Nodes, are dead weight in the stored JSON. This is
 * the boundary function: parse fully, resolve, then `compact` before writing.
 *
 * Differences from a compact parse, both deliberate:
 *  - The root is always kept. A compact *parse* unwraps a single-child
 *    `document`; here documents are stored and rendered as documents.
 *  - Errors are preserved wherever they exist, so a stored AST still carries
 *    its diagnostics.
 *
 * Never mutates its input — callers may still be holding the full AST. New
 * Nodes, attribute objects, child arrays and slot maps are created; attribute
 * *values* (including `Variable` and `Function` instances) are shared as-is.
 */
function isNode(value: unknown): value is Node {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { $$mdtype?: string }).$$mdtype === 'Node'
  );
}

function compactNode(node: Node): Node {
  // Field assignment order matters: it fixes JSON key order, which has to match
  // what a compact parse emits.
  const result = new Node(
    node.type,
    { ...node.attributes },
    compactChildren(node.children),
    node.tag
  );

  if (node.inline) result.inline = true;
  if (node.errors?.length) result.errors = [...node.errors];

  // A tag's annotations are redundant after parsing: the same values are in
  // `attributes`, and the formatter prints a tag from `attributes` too, so
  // dropping them changes neither rendering nor `format()` output. Other node
  // types keep theirs — a fence's `title` annotation, for one, is read back
  // from stored trees at render time and is not mirrored in `attributes`.
  if (node.type !== 'tag' && node.annotations?.length)
    result.annotations = [...node.annotations];

  if (node.slots)
    for (const [name, slot] of Object.entries(node.slots))
      result.addSlot(name, compactNode(slot));

  return result;
}

function compactChildren(children: Node[]): Node[] {
  const result: Node[] = [];

  for (const child of children) {
    if (!isNode(child)) {
      // Defensive: children are typed as Node[] but some pipelines place
      // scalars here. Pass anything unrecognized through untouched.
      result.push(child);
      continue;
    }

    if (child.type === 'inline') {
      // The wrapper carries nothing of its own — a compact parse never creates
      // it — and its descendants already have `inline: true` from the parse.
      result.push(...compactChildren(child.children));
      continue;
    }

    result.push(compactNode(child));
  }

  return result;
}

export function compact(node: Node): Node;
export function compact(nodes: Node[]): Node[];
export function compact(input: Node | Node[]): Node | Node[] {
  return Array.isArray(input) ? compactChildren(input) : compactNode(input);
}

export default compact;
