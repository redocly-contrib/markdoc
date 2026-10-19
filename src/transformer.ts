import Tag from './tag';
import { Class } from './schema-types/class';
import { Id } from './schema-types/id';
import { isPromise } from './utils';
import type {
  Config,
  MaybePromise,
  Node,
  NodeType,
  RenderableTreeNodes,
  Schema,
  SchemaAttribute,
  Transformer,
} from './types';

type AttributesSchema = Schema['attributes'];

export const globalAttributes: AttributesSchema = {
  class: { type: Class, render: true },
  id: { type: Id, render: true },
};

// Attribute types are instantiated only to look up `transform`/`validate` on
// the instance. The built-in ones keep no state, so one instance of each
// serves every node; custom types are still constructed per use, as before.
const builtInTypeInstances = new Map<unknown, unknown>([
  [Class, new Class()],
  [Id, new Id()],
  [String, new String()],
  [Number, new Number()],
  [Boolean, new Boolean()],
  [Array, []],
  [Object, new Object()],
]);

/** `new type()`, reusing a shared instance for the stateless built-in types. */
export function typeInstance(type: new () => unknown): any {
  return builtInTypeInstances.get(type) ?? new type();
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function transformAttribute(
  output: Record<string, any>,
  key: string,
  attr: SchemaAttribute,
  node: Node,
  config: Config
) {
  if (attr.render == false) return;

  const name = typeof attr.render === 'string' ? attr.render : key;

  let value = node.attributes[key];
  if (typeof attr.type === 'function') {
    const instance = typeInstance(attr.type);
    if (instance.transform) {
      value = instance.transform(value, config);
    }
  }
  value = value === undefined ? attr.default : value;

  if (value === undefined) return;
  output[name] = value;
}

/**
 * In compact mode, a wrapper that carries no information of its own is dropped
 * and its children are returned in its place:
 *
 *  - a `document` whose only child is a block (and which has no frontmatter to
 *    preserve), so the output is not wrapped in `<article>`;
 *  - a `paragraph` whose only child is a block-level markdoc tag, which the
 *    parser only wrapped because of the implied-paragraph rule.
 *
 * This lives here rather than on the schemas so that a `render` override on
 * `document`/`paragraph` is still honored when no elision happens.
 */
function elidesWrapper(node: Node, config: Config): boolean {
  if (node.type === 'document')
    return node.children.length === 1 && !node.attributes.frontmatter;

  if (node.type === 'paragraph') {
    if (node.children.length !== 1) return false;
    let child = node.children[0];
    // The non-compact tree wraps inline content in an `inline` Node.
    if (child.type === 'inline' && child.children.length === 1)
      child = child.children[0];
    if (child.type !== 'tag' || !child.tag) return false;
    const tagSchema = config.tags?.[child.tag];
    return !!tagSchema && tagSchema.inline !== true;
  }

  return false;
}

export default {
  findSchema(node: Node, { nodes = {}, tags = {} }: Config = {}) {
    return node.tag ? tags[node.tag] : nodes[node.type as NodeType];
  },

  attributes(node: Node, config: Config = {}) {
    const schema = this.findSchema(node, config) ?? {};
    const output: Record<string, any> = {};

    // Visits `{ ...globalAttributes, ...schema.attributes }` in that object's
    // key order without building it for every node.
    const schemaAttributes = schema.attributes;
    for (const key of Object.keys(globalAttributes!))
      transformAttribute(
        output,
        key,
        schemaAttributes && hasOwn(schemaAttributes, key)
          ? schemaAttributes[key]
          : globalAttributes![key],
        node,
        config
      );
    if (schemaAttributes)
      for (const key of Object.keys(schemaAttributes))
        if (!hasOwn(globalAttributes!, key))
          transformAttribute(output, key, schemaAttributes[key], node, config);

    if (schema.slots) {
      for (const [key, slot] of Object.entries(schema.slots)) {
        if (slot.render === false) continue;
        const name = typeof slot.render === 'string' ? slot.render : key;
        const slotNode = node.slots?.[key];
        if (slotNode) output[name] = this.node(slotNode, config);
      }
    }

    return output;
  },

  children(node: Node, config: Config = {}) {
    const children = node.children.flatMap<MaybePromise<RenderableTreeNodes>>(
      (child) => this.node(child, config)
    );
    if (children.some(isPromise)) {
      return Promise.all(children);
    }
    return children;
  },

  node(node: Node, config: Config = {}) {
    const schema = this.findSchema(node, config) ?? {};
    // A custom transform wins, so a consumer can always override completely.
    if (schema && schema.transform instanceof Function)
      return schema.transform(node, config);

    const children = this.children(node, config);

    if (config.compact && elidesWrapper(node, config)) return children;

    if (!schema || !schema.render) return children;

    const attributes = this.attributes(node, config);

    if (isPromise(attributes) || isPromise(children)) {
      return Promise.all([attributes, children]).then(
        (values) => new Tag(schema.render, ...values)
      );
    }

    return new Tag(schema.render, attributes, children);
  },
} as Transformer;
