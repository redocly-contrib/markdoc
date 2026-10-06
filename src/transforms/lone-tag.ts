import type { Node, ParserArgs } from '../types';

function loneTagChild(paragraph: Node): Node | undefined {
  if (paragraph.type !== 'paragraph') return undefined;
  if (paragraph.annotations?.length) return undefined;
  if (paragraph.children.length !== 1) return undefined;
  let child = paragraph.children[0];
  // The non-compact tree wraps inline content in an `inline` Node:
  //   paragraph > inline > tag
  // Look through a single-child inline to find the tag.
  if (child.type === 'inline' && child.children.length === 1) {
    child = child.children[0];
  }
  if (child.type !== 'tag') return undefined;
  return child;
}

function unwrapIn(node: Node) {
  // Walk children of `node` and unwrap any lone-tag paragraphs in place.
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const tag = loneTagChild(child);
    if (tag) {
      node.children[i] = tag;
    } else {
      unwrapIn(child);
    }
  }
  // Slots too — they're alternative children trees.
  for (const slot of Object.values(node.slots ?? {})) {
    unwrapIn(slot);
  }
}

export default function transform(document: Node, args?: ParserArgs) {
  if (!args?.noParagraphForLoneTag) return;
  unwrapIn(document);
}
