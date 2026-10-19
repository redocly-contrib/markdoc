/**
 * Turns token-shaped objects into Nodes, as Markdoc's `handleToken` did for
 * markdown-it tokens. `build.ts` builds Nodes from the parser's own tokens;
 * this handles the plain objects it gets from elsewhere, which are only ever
 * the text, tag, variable, annotation and error tokens `parseTags` finds in
 * fence content, and the text and tag tokens an HTML handler emits.
 */
import Node from '../ast/node';
import { annotate } from './annotate';

import type { NodeType } from '../types';

/**
 * A token from `parseTags` or an HTML handler. Producers set only what they
 * have — a text token has no `nesting`, for one — so every field but `type`
 * is optional.
 */
export type ObjectToken = { type: string; [field: string]: any };

/** `tag_open` and `tag_close` are `tag`s, and a variable is `text`. */
function typeNameOf(type: string): string {
  if (type.endsWith('_open')) return type.slice(0, -5);
  if (type.endsWith('_close')) return type.slice(0, -6);
  return type === 'variable' ? 'text' : type;
}

export function handleToken(
  token: ObjectToken,
  nodes: Node[],
  file?: string,
  handleSlots?: boolean,
  addLocation?: boolean,
  compact?: boolean,
  inlineParent?: Node
) {
  if (token.type === 'text' && token.content === '') return;

  const errors: any[] = [];
  const parent = nodes[nodes.length - 1];
  const { tag, attributes, error, variable } = token.meta || {};

  if (token.type === 'annotation') {
    if (inlineParent) return annotate(inlineParent, attributes);

    return parent.addError({
      id: 'no-inline-annotations',
      level: 'error',
      message: `Can't apply inline annotations to '${parent.type}'`,
    });
  }

  const typeName = typeNameOf(token.type);

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
      nodes.pop();
      return;
    }

    errors.push({
      id: 'missing-opening',
      level: 'critical',
      message: `Node '${typeName}' is missing opening`,
    });
  }

  const node = new Node(
    typeName as NodeType,
    typeName === 'text' ? { content: variable || token.content } : {},
    undefined,
    tag || undefined
  );
  const { position = {} } = token;

  for (const e of errors) node.addError(e);

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

  if (attributes && typeName === 'tag') annotate(node, attributes);

  if (
    handleSlots &&
    tag === 'slot' &&
    typeof node.attributes.primary === 'string'
  )
    parent.addSlot(node.attributes.primary, node);
  else parent.push(node);

  if (token.nesting > 0) nodes.push(node);
}
