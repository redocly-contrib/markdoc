import Node, { hasPosition } from './node';
import Function from './function';
import Variable from './variable';

import type { Location, NodeType, ValidationError } from '../types';

/**
 * A compact, lossless storage format for an AST, as plain JSON-compatible
 * data. Nodes are recognized by position instead of carrying `$$mdtype`, and
 * fields holding defaults are left out:
 *
 * - a plain inline text node is just its content string;
 * - any other node is `[head, attributes?, ...children]`, where `head` is the
 *   node type, or `%name` for a tag, prefixed with `~` when the node is inline.
 *   `attributes` is present only when non-empty;
 * - rarely-set fields ride along in `attributes` under `$`-keys, which can
 *   never clash with an attribute because attribute names are identifiers:
 *   `$e` errors, `$a` annotations, `$s` slots, `$l` location, and `$t` for a
 *   tag name on a node whose type is not `tag`. A hand-built node whose own
 *   attribute names start with `$` keeps them whole under `$A`;
 * - a list of nodes is `{ "$list": [...] }`;
 * - anything in `children` that is not a Node (which some pipelines put
 *   there) is `["$", value]`, as no node head is `$`.
 *
 * `unpack(pack(ast))` serializes exactly like `Ast.fromJSON(JSON.stringify(ast))`.
 */
export type PackedNode = string | [string, ...unknown[]];
export type Packed = PackedNode | { $list: PackedNode[] };

const INLINE = '~';
const TAG = '%';
const RAW = '$';

function isEmpty(object: object | undefined): boolean {
  if (object) for (const _ in object) return false;
  return true;
}

/** `attributes` is exactly `{ content: <string> }`. */
function isOnlyContent(attributes: Record<string, any>): boolean {
  let count = 0;
  for (const key in attributes) {
    if (key !== 'content' || ++count > 1) return false;
  }
  return count === 1 && typeof attributes.content === 'string';
}

function hasDollarKey(attributes: Record<string, any>): boolean {
  for (const key in attributes) if (key.charCodeAt(0) === 36) return true;
  return false;
}

function isNode(value: unknown): value is Node {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { $$mdtype?: string }).$$mdtype === 'Node'
  );
}

/**
 * Packs `node`. With `compact`, applies `compact()` on the way — drops
 * locations, the annotations of tags, and `inline` wrapper Nodes — without
 * building the intermediate tree.
 */
function packNode(node: Node, compact: boolean): PackedNode {
  const { type, tag, attributes } = node;
  const errors = node.errors ?? [];
  const annotations = compact && type === 'tag' ? [] : node.annotations ?? [];
  const location =
    !compact && hasPosition(node.location) ? node.location : undefined;

  if (
    type === 'text' &&
    node.inline &&
    tag === undefined &&
    node.children.length === 0 &&
    errors.length === 0 &&
    annotations.length === 0 &&
    isEmpty(node.slots) &&
    !location &&
    isOnlyContent(attributes)
  )
    return attributes.content;

  let head: string = type === 'tag' && tag !== undefined ? TAG + tag : type;
  if (node.inline) head = INLINE + head;

  const escaped = hasDollarKey(attributes);
  let packedAttributes: Record<string, unknown> = attributes;
  if (
    escaped ||
    (type !== 'tag' && tag !== undefined) ||
    errors.length ||
    annotations.length ||
    !isEmpty(node.slots) ||
    location
  ) {
    packedAttributes = escaped ? { $A: attributes } : { ...attributes };
    if (type !== 'tag' && tag !== undefined) packedAttributes.$t = tag;
    if (errors.length) packedAttributes.$e = errors;
    if (annotations.length) packedAttributes.$a = annotations;
    if (!isEmpty(node.slots)) {
      const slots: Record<string, PackedNode> = {};
      for (const name of Object.keys(node.slots))
        slots[name] = packNode(node.slots[name], compact);
      packedAttributes.$s = slots;
    }
    if (location) packedAttributes.$l = location;
  }

  const output: [string, ...unknown[]] = [head];
  if (!isEmpty(packedAttributes)) output.push(packedAttributes);
  packChildren(node.children, compact, output);
  return output;
}

function packChildren(children: Node[], compact: boolean, output: unknown[]) {
  for (const child of children) {
    // Defensive, as in `compact()`: keep anything that is not a Node as is.
    if (!isNode(child)) output.push([RAW, child]);
    else if (compact && child.type === 'inline')
      packChildren(child.children, compact, output);
    else output.push(packNode(child, compact));
  }
  return output;
}

export type PackOptions = {
  /** Store `compact(value)` instead, in the same single pass. */
  compact?: boolean;
};

/** Packs a node (or list of nodes) into the compact storage format. */
export function pack(
  value: Node | Node[],
  { compact = false }: PackOptions = {}
): Packed {
  if (Array.isArray(value))
    return { $list: packChildren(value, compact, []) as PackedNode[] };
  return packNode(value, compact);
}

/**
 * A deep copy of an attribute value with `$$mdtype` objects turned back into
 * AST class instances, as `Ast.fromJSON` does. Copying keeps `unpack` from
 * mutating its input, which callers may hold on to and unpack again.
 */
function reviveCopy(value: any): any {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const output = new Array(value.length);
    for (let i = 0; i < value.length; i++) output[i] = reviveCopy(value[i]);
    return output;
  }

  const output: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(output, key, {
      value: reviveCopy(value[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  switch (output.$$mdtype) {
    case 'Node':
      return Object.assign(new Node(), output);
    case 'Variable':
      return Object.assign(new Variable(), output);
    case 'Function':
      return Object.assign(new (Function as any)(), output);
    default:
      return output;
  }
}

/** Copies attributes, which hold only scalars and plain values in practice. */
function copyAttributes(value: Record<string, any>): Record<string, any> {
  const output: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    if (key.charCodeAt(0) === 36 /* $ */) continue;
    const item = value[key];
    const copy =
      item !== null && typeof item === 'object' ? reviveCopy(item) : item;
    // Assigning `__proto__` would set the prototype rather than the attribute.
    if (key === '__proto__')
      Object.defineProperty(output, key, {
        value: copy,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    else output[key] = copy;
  }
  return output;
}

function unpackNode(value: PackedNode): Node {
  if (typeof value === 'string') {
    const node = new Node('text', { content: value }, [], undefined);
    node.inline = true;
    return node;
  }

  let head = value[0];
  if (head === RAW) return value[1] as Node;
  let inline = false;
  if (head.charCodeAt(0) === 126 /* ~ */) {
    inline = true;
    head = head.slice(1);
  }

  let type: NodeType;
  let tag: string | undefined;
  if (head.charCodeAt(0) === 37 /* % */) {
    type = 'tag';
    tag = head.slice(1);
  } else {
    type = head as NodeType;
  }

  let start = 1;
  let packedAttributes: Record<string, any> | undefined;
  const second = value[1];
  if (
    value.length > 1 &&
    second !== null &&
    typeof second === 'object' &&
    !Array.isArray(second)
  ) {
    packedAttributes = second as Record<string, any>;
    start = 2;
  }

  const children = new Array(value.length - start);
  for (let i = start; i < value.length; i++)
    children[i - start] = unpackNode(value[i] as PackedNode);

  const attributes = !packedAttributes
    ? {}
    : packedAttributes.$A !== undefined
    ? reviveCopy(packedAttributes.$A)
    : copyAttributes(packedAttributes);
  if (packedAttributes?.$t !== undefined) tag = packedAttributes.$t;

  const node = new Node(type, attributes, children, tag);
  if (inline) node.inline = true;

  if (packedAttributes) {
    const { $e, $a, $s, $l } = packedAttributes;
    if ($e) node.errors = reviveCopy($e) as ValidationError[];
    if ($a) node.annotations = reviveCopy($a);
    if ($s)
      for (const name of Object.keys($s))
        node.slots[name] = unpackNode($s[name]);
    if ($l) node.location = reviveCopy($l) as Location;
  }

  return node;
}

/** Turns the compact storage format back into AST nodes. Never mutates `value`. */
export function unpack(value: Packed): Node | Node[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value.$list.map(unpackNode);
  return unpackNode(value);
}
