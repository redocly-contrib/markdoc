import { resolve, resolveShared } from './base';
import transformer from '../transformer';
import type {
  AstType,
  AttributeValue,
  Config,
  Location,
  MaybePromise,
  NodeType,
  RenderableTreeNode,
  RenderableTreeNodes,
  Schema,
  ValidationError,
} from '../types';

/** A `location` built from a token with no `map` carries nothing worth storing. */
export function hasPosition(location?: Location): boolean {
  if (!location) return false;
  return (
    location.file !== undefined ||
    location.start?.line !== undefined ||
    location.end?.line !== undefined
  );
}

/**
 * `node.resolve(config)` without copying what does not change: returns the
 * node itself when nothing in it or below it holds a variable or function,
 * and otherwise copies only the nodes on the way to one. Resolution happens
 * in the same order as `resolve` (children, then attributes, then slots).
 */
export function resolveNodeShared(node: Node, config: Config): Node {
  // A Node whose `resolve` was replaced keeps resolving its own way.
  if (
    typeof node.resolve === 'function' &&
    node.resolve !== Node.prototype.resolve
  )
    return node.resolve(config);
  const children = resolveShared(node.children, config, resolveNodeShared);
  const attributes = resolveShared(node.attributes, config, resolveNodeShared);
  let slots = node.slots;
  if (slots)
    for (const name of Object.keys(slots)) {
      const slot = resolveNodeShared(node.slots[name], config);
      if (slot !== node.slots[name]) {
        if (slots === node.slots) slots = { ...slots };
        slots[name] = slot;
      }
    }

  if (
    children === node.children &&
    attributes === node.attributes &&
    slots === node.slots
  )
    return node;

  return Object.assign(new Node(), node, {
    children,
    attributes,
    slots: slots ?? {},
  });
}

/** What `walk()` visits below a node: its slots, then its children. */
function walkTargets(node: Node): Node[] {
  // Tolerates hand-built plain objects, which some callers cast to Node.
  const slots = node.slots ? Object.values(node.slots) : [];
  return slots.length ? [...slots, ...node.children] : node.children.slice();
}

export default class Node implements AstType {
  readonly $$mdtype = 'Node';

  attributes: Record<string, any>;
  slots: Record<string, Node>;
  children: Node[];
  errors: ValidationError[];
  type: NodeType;
  tag?: string;
  annotations: AttributeValue[];

  inline = false;
  location?: Location;

  constructor(
    type: NodeType = 'node',
    attributes: Record<string, any> = {},
    children: Node[] = [],
    tag?: string
  ) {
    this.attributes = attributes;
    this.children = children;
    this.type = type;
    this.tag = tag;
    // Always present, so upstream-style `node.annotations.length` works. The
    // size saving lives in `toJSON`, which omits them while empty, rather than
    // in leaving them undefined — reading a field can then never change what
    // gets serialized.
    this.errors = [];
    this.annotations = [];
    this.slots = {};
  }

  addError(error: ValidationError) {
    this.errors.push(error);
  }

  addAnnotation(annotation: AttributeValue) {
    this.annotations.push(annotation);
  }

  addSlot(name: string, node: Node) {
    this.slots[name] = node;
  }

  /**
   * Serializes only what carries information, so an AST stored as JSON stays
   * small while every field remains readable in memory.
   *
   * Omitted: `errors`, `annotations` and `slots` while empty, `inline` while
   * false, and a `location` with no file or line. `Ast.fromJSON` restores each
   * one from the constructor defaults, so a revived tree behaves identically.
   */
  toJSON() {
    // Key order matches the previous own-property order, minus omissions, to
    // keep stored output stable for consumers diffing it.
    const output: Record<string, unknown> = { $$mdtype: this.$$mdtype };

    if (this.inline) output.inline = true;
    output.attributes = this.attributes;
    output.children = this.children;
    output.type = this.type;
    if (this.tag !== undefined) output.tag = this.tag;
    if (this.errors?.length) output.errors = this.errors;
    if (this.annotations?.length) output.annotations = this.annotations;
    if (this.slots && Object.keys(this.slots).length) output.slots = this.slots;
    if (hasPosition(this.location)) output.location = this.location;

    return output;
  }

  *walk(): Generator<Node, void, unknown> {
    // Iterative rather than one nested generator per ancestor, so yielding a
    // node costs O(1) instead of O(depth). Each node's children are still
    // snapshotted only when the walk descends into it — after the consumer has
    // seen that node — so replacing `node.children` mid-walk (as the table
    // transform does) is followed exactly as before.
    const lists: Node[][] = [walkTargets(this)];
    const positions: number[] = [0];
    while (lists.length) {
      const top = lists.length - 1;
      const list = lists[top];
      if (positions[top] >= list.length) {
        lists.pop();
        positions.pop();
        continue;
      }
      const child = list[positions[top]++];
      yield child;
      if (
        child.walk === Node.prototype.walk ||
        typeof child.walk !== 'function'
      ) {
        lists.push(walkTargets(child));
        positions.push(0);
      } else {
        // A child whose `walk` was replaced walks its own way, as each child's
        // `walk` did before.
        yield* child.walk();
      }
    }
  }

  push(node: Node) {
    this.children.push(node);
  }

  resolve(config: Config = {}): Node {
    return Object.assign(new Node(), this, {
      children: this.children.map((child) => child.resolve(config)),
      attributes: resolve(this.attributes, config),
      slots: Object.fromEntries(
        Object.entries(this.slots ?? {}).map(([name, slot]) => [
          name,
          slot.resolve(config),
        ])
      ),
    });
  }

  findSchema(config: Config = {}): Schema | undefined {
    return transformer.findSchema(this, config);
  }

  transformAttributes(config: Config = {}) {
    return transformer.attributes(this, config);
  }

  transformChildren(config: Config): RenderableTreeNode[] {
    return transformer.children(this, config);
  }

  transform(config: Config): MaybePromise<RenderableTreeNodes> {
    return transformer.node(this, config);
  }
}
