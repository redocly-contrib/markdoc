import Node from './ast/node';
import transforms from './transforms/index';
import { OPEN } from './utils';

import type { AttributeValue, ParserArgs } from './types';

import type Token from 'markdown-it/lib/token';

const mappings: Record<string, string> = {
  ordered_list: 'list',
  bullet_list: 'list',
  code_inline: 'code',
  list_item: 'item',
  variable: 'text',
};

function annotate(node: Node, attributes: AttributeValue[]) {
  for (const attribute of attributes) {
    node.addAnnotation(attribute);

    const { name, value, type } = attribute;
    if (type === 'attribute') {
      if (node.attributes[name] !== undefined)
        node.addError({
          id: 'duplicate-attribute',
          level: 'warning',
          message: `Attribute '${name}' already set`,
        });
      node.attributes[name] = value;
    } else if (type === 'class')
      if (node.attributes.class) node.attributes.class[name] = value;
      else node.attributes.class = { [name]: value };
  }
}

function handleAttrs(token: Token, type: string) {
  switch (type) {
    case 'heading':
      return { level: Number(token.tag.replace('h', '')) };
    case 'list': {
      const attrs = token.attrs ? Object.fromEntries(token.attrs) : undefined;
      const ordered = token.type.startsWith('ordered');
      return ordered && attrs?.start
        ? { ordered: true, start: attrs.start, marker: token.markup }
        : { ordered, marker: token.markup };
    }
    case 'link': {
      const attrs = Object.fromEntries(token.attrs);
      return attrs.title
        ? { href: attrs.href, title: attrs.title }
        : { href: attrs.href };
    }
    case 'image': {
      const attrs = Object.fromEntries(token.attrs);
      return attrs.title
        ? { alt: token.content, src: attrs.src, title: attrs.title }
        : { alt: token.content, src: attrs.src };
    }
    case 'em':
    case 'strong':
      return { marker: token.markup };
    case 'text':
    case 'code':
    case 'comment':
      return { content: (token.meta || {}).variable || token.content };
    case 'fence': {
      const [language] = token.info.split(' ', 1);
      return language === '' || language === OPEN
        ? { content: token.content }
        : { content: token.content, language };
    }
    case 'blockquote': {
      if (token.attrs) {
        const attrs = Object.fromEntries(token.attrs);
        if (attrs.kind) return { kind: attrs.kind };
      }
      return {};
    }
    case 'td':
    case 'th': {
      if (token.attrs) {
        const attrs = Object.fromEntries(token.attrs);

        let align;
        if (attrs.style) {
          if (attrs.style.includes('left')) {
            align = 'left';
          } else if (attrs.style.includes('center')) {
            align = 'center';
          } else if (attrs.style.includes('right')) {
            align = 'right';
          }
        }

        if (align) {
          return { align };
        }
      }
      return {};
    }
    default:
      return {};
  }
}

function handleToken(
  token: Token,
  nodes: Node[],
  file?: string,
  handleSlots?: boolean,
  addLocation?: boolean,
  compact?: boolean,
  inlineParent?: Node
) {
  if (token.type === 'frontmatter') {
    nodes[0].attributes.frontmatter = token.content;
    return;
  }

  if (token.hidden || (token.type === 'text' && token.content === '')) return;

  const errors = token.errors || [];
  const parent = nodes[nodes.length - 1];
  const { tag, attributes, error } = token.meta || {};

  if (token.type === 'annotation') {
    if (inlineParent) return annotate(inlineParent, attributes);

    return parent.addError({
      id: 'no-inline-annotations',
      level: 'error',
      message: `Can't apply inline annotations to '${parent.type}'`,
    });
  }

  let typeName = token.type.replace(/_(open|close)$/, '');
  if (mappings[typeName]) typeName = mappings[typeName];

  if (typeName === 'error') {
    const { message, location } = error;
    errors.push({ id: 'parse-error', level: 'critical', message, location });
  }

  if (token.nesting < 0) {
    if (parent.type === typeName && parent.tag === tag) {
      // Extend the container's location to cover its closing token. Without
      // this, a multi-line construct (notably a markdoc `{% tag %}` block)
      // would report `location.end` as the end of its *opening* token.
      if (!compact && addLocation !== false && token.map && parent.location)
        parent.location.end = {
          line: token.map[1],
          character: token.position?.end ?? parent.location.end.character,
        };
      return nodes.pop();
    }

    errors.push({
      id: 'missing-opening',
      level: 'critical',
      message: `Node '${typeName}' is missing opening`,
    });
  }

  // Compact mode: don't materialize the inline wrapper Node — recurse
  // children straight into the surrounding parent (paragraph/heading/etc.).
  if (compact && typeName === 'inline') {
    if (Array.isArray(token.children)) {
      const newInlineParent = parent;
      for (const child of token.children)
        handleToken(child, nodes, file, handleSlots, addLocation, compact, newInlineParent);
    }
    return;
  }

  const attrs = handleAttrs(token, typeName);
  const node = new Node(typeName, attrs, undefined, tag || undefined);
  const { position = {} } = token;

  if (errors.length) for (const e of errors) node.addError(e);

  if (!compact && addLocation !== false) {
    // Inline tokens carry no `map` of their own, so they inherit the span of
    // the enclosing block from its location.
    const span =
      token.map ||
      (parent.location
        ? [parent.location.start.line, parent.location.end.line]
        : []);
    node.location = {
      file,
      start: {
        line: span[0],
        character: position.start,
      },
      end: {
        line: span[1],
        character: position.end,
      },
    };
  }

  if (inlineParent) node.inline = true;

  if (attributes && ['tag', 'fence', 'image'].includes(typeName))
    annotate(node, attributes);

  if (
    handleSlots &&
    tag === 'slot' &&
    typeof node.attributes.primary === 'string'
  )
    parent.slots[node.attributes.primary] = node;
  else parent.push(node);

  if (token.nesting > 0) nodes.push(node);

  if (!Array.isArray(token.children)) return;

  if (node.type === 'inline') inlineParent = parent;

  nodes.push(node);

  const isLeafNode = typeName === 'image';
  if (!isLeafNode) {
    for (const child of token.children)
      handleToken(child, nodes, file, handleSlots, addLocation, compact, inlineParent);
  }

  nodes.pop();
}

export default function parser(tokens: Token[], args?: string | ParserArgs) {
  const doc = new Node('document');
  const nodes = [doc];

  if (typeof args === 'string') args = { file: args };

  for (const token of tokens)
    handleToken(token, nodes, args?.file, args?.slots, args?.location, args?.compact);

  if (nodes.length > 1)
    for (const node of nodes.slice(1))
      node.addError({
        id: 'missing-closing',
        level: 'critical',
        message: `Node '${node.tag || node.type}' is missing closing`,
      });

  for (const transform of transforms) transform(doc, args);

  return doc;
}
