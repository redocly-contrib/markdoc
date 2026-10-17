/**
 * Turns the fast parser's tokens into Markdoc Nodes: a port of `parser.ts`'s
 * `handleToken`, plus the token rewrites Markdoc's markdown-it plugins do in
 * their core rules (fence tags, link validation, GitHub admonitions), applied
 * at the point the token is consumed rather than in a pass of their own.
 *
 * Inline content is parsed here, when its `inline` token is reached, which is
 * exactly when markdown-it's result would be consumed: after every block (and
 * so every link reference definition) has been read.
 */
import Node from '../ast/node';
import transforms from '../transforms/index';
import tableTransform from '../transforms/table';
import { handleToken as handleObjectToken } from '../parser';
import { containsMarkdocTagInUrl, findTagEnd, parseTags, OPEN } from '../utils';
import { parse as parseTag, SyntaxError } from '../grammar/tag';
import Variable from '../ast/variable';
import Function from '../ast/function';
import { ADMONITION_KINDS } from '../tokenizer/plugins/githubAdmonitions';
import * as T from './tokens';
import { NESTING, NODE_TYPE, BlockToken, InlineToken } from './tokens';
import type { BlockState } from './block';
import type { InlineState } from './inline';
import type { AttributeValue, Location, ParserArgs } from '../types';

export type BuildOptions = {
  allowLinkValidation: boolean;
  validatedProtocols: string[];
  githubAdmonitions: boolean;
};

const ADMONITION_KIND_SET: Set<string> = new Set(ADMONITION_KINDS);
const ADMONITION_RE = /^\[!([A-Za-z]+)]\s*(?:\n|$)/;

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

function fenceAttributes(token: BlockToken) {
  const info = token.info;
  const space = info.indexOf(' ');
  const language = space === -1 ? info : info.slice(0, space);
  return language === '' || language === OPEN
    ? { content: token.content }
    : { content: token.content, language };
}

function listAttributes(token: BlockToken) {
  const ordered =
    token.type === T.ORDERED_LIST_OPEN || token.type === T.ORDERED_LIST_CLOSE;
  // markdown-it only sets the `start` attribute when it is not 1, and Markdoc
  // only keeps a truthy one.
  return token.type === T.ORDERED_LIST_OPEN && token.num !== 1 && token.num
    ? { ordered: true, start: token.num, marker: token.markup }
    : { ordered, marker: token.markup };
}

function blockAttributes(token: BlockToken): Record<string, any> {
  switch (token.type) {
    case T.HEADING_OPEN:
    case T.HEADING_CLOSE:
      return { level: token.num };
    case T.BULLET_LIST_OPEN:
    case T.BULLET_LIST_CLOSE:
    case T.ORDERED_LIST_OPEN:
    case T.ORDERED_LIST_CLOSE:
      return listAttributes(token);
    case T.FENCE:
      return fenceAttributes(token);
    case T.COMMENT:
      return { content: token.content };
    case T.VARIABLE:
      return { content: (token.meta || {}).variable || token.content };
    case T.BLOCKQUOTE_OPEN:
      return token.str ? { kind: token.str } : {};
    case T.TH_OPEN:
    case T.TD_OPEN:
      return token.str ? { align: token.str } : {};
    default:
      return {};
  }
}

function inlineAttributes(token: InlineToken): Record<string, any> {
  switch (token.type) {
    case T.TEXT:
    case T.VARIABLE:
    case T.CODE_INLINE:
    case T.COMMENT:
      return { content: (token.meta || {}).variable || token.content };
    case T.EM_OPEN:
    case T.EM_CLOSE:
    case T.STRONG_OPEN:
    case T.STRONG_CLOSE:
      return { marker: token.markup };
    case T.LINK_OPEN:
      return token.title
        ? { href: token.href, title: token.title }
        : { href: token.href };
    case T.LINK_CLOSE:
      // Markdoc reads `Object.fromEntries(token.attrs)`, and a closing link
      // token has no attrs, so an unmatched one throws there too.
      throw new TypeError(
        'object null is not iterable (cannot read property Symbol(Symbol.iterator))'
      );
    case T.IMAGE:
      return token.title
        ? { alt: token.content, src: token.href, title: token.title }
        : { alt: token.content, src: token.href };
    default:
      return {};
  }
}

/** What Markdoc's annotations core rule does to a fence token. */
function processFence(token: BlockToken): any[] | undefined {
  if (token.info.includes(OPEN)) {
    const start = token.info.indexOf(OPEN);
    const end = findTagEnd(token.info, start);
    const content = token.info.slice(start + OPEN.length, end as number);

    try {
      const { meta } = parseTag(content.trim(), { Variable, Function });
      token.meta = meta;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!token.errors) token.errors = [];
      token.errors.push({
        id: 'fence-tag-error',
        level: 'error',
        message: `Syntax error in fence tag: ${(error as any).message}`,
      });
    }
  }

  if (
    token?.meta?.attributes?.find(
      (attr: AttributeValue) => attr.name === 'process' && !attr.value
    )
  )
    return undefined;

  return parseTags(token.content, token.map0);
}

export function build(
  block: BlockState,
  inline: InlineState,
  options: BuildOptions,
  args?: ParserArgs
): Node {
  const doc = new Node('document');
  const nodes: Node[] = [doc];
  const file = args?.file;
  const handleSlots = args?.slots;
  const addLocation = args?.location;
  const compact = args?.compact;
  const locate = !compact && addLocation !== false;

  const pool = block.pool;
  const length = block.length;

  // Admonition rewrites, found when their blockquote is reached.
  let skipUntil = -1;
  let sliceInline: BlockToken | undefined;

  function location(map0: number, map1: number, parent: Node): Location {
    let start: number | undefined;
    let end: number | undefined;
    if (map0 >= 0) {
      start = map0;
      end = map1;
    } else if (parent.location) {
      // Inline tokens carry no `map` of their own, so they inherit the span of
      // the enclosing block from its location.
      start = parent.location.start.line;
      end = parent.location.end.line;
    }
    return {
      file,
      start: { line: start as number, character: undefined },
      end: { line: end as number, character: undefined },
    };
  }

  // The table transform only acts on `table` tags; when none were created it
  // has nothing to do but walk the whole tree.
  let sawTable = false;

  function place(node: Node, parent: Node, tag: string | undefined) {
    if (tag === 'table') sawTable = true;
    if (
      handleSlots &&
      tag === 'slot' &&
      typeof node.attributes.primary === 'string'
    )
      parent.addSlot(node.attributes.primary, node);
    else parent.push(node);
  }

  function handleInline(token: InlineToken, inlineParent: Node) {
    const type = token.type;
    if (type === T.TEXT && token.content === '') return;

    const parent = nodes[nodes.length - 1];
    const meta = token.meta;
    const tag = meta ? meta.tag : undefined;

    if (type === T.ANNOTATION) {
      annotate(inlineParent, meta.attributes);
      return;
    }

    const typeName = NODE_TYPE[type];
    const nesting = NESTING[type];
    let errors: any[] | undefined;

    if (type === T.ERROR) {
      const { message, location } = meta.error;
      errors = [{ id: 'parse-error', level: 'critical', message, location }];
    }

    if (nesting < 0) {
      if (parent.type === typeName && parent.tag === tag) {
        nodes.pop();
        return;
      }
      (errors ??= []).push({
        id: 'missing-opening',
        level: 'critical',
        message: `Node '${typeName}' is missing opening`,
      });
    }

    const node = new Node(
      typeName as any,
      inlineAttributes(token),
      undefined,
      tag || undefined
    );

    if (errors) for (const e of errors) node.addError(e);

    if (locate) node.location = location(-1, -1, parent);

    node.inline = true;

    const attributes = meta ? meta.attributes : undefined;
    if (attributes && (typeName === 'tag' || typeName === 'image'))
      annotate(node, attributes);

    place(node, parent, tag);

    if (nesting > 0) nodes.push(node);
  }

  function parseInline(token: BlockToken) {
    inline.parse(token.content, block.references);
    let start = 0;
    if (sliceInline === token) {
      // GitHub admonition: drop the marker line from the children.
      const tokens = inline.pool;
      for (let i = 0; i < inline.length; i++) {
        if (tokens[i].type === T.SOFTBREAK || tokens[i].type === T.HARDBREAK) {
          start = i + 1;
          break;
        }
      }
      sliceInline = undefined;
    }
    return start;
  }

  function handleBlock(token: BlockToken) {
    const type = token.type;

    if (type === T.FRONTMATTER) {
      nodes[0].attributes.frontmatter = token.content;
      return;
    }

    if (token.hidden) return;

    const parent = nodes[nodes.length - 1];

    let fenceChildren: any[] | undefined;
    if (type === T.FENCE) fenceChildren = processFence(token);

    if (
      options.allowLinkValidation &&
      type === T.INLINE &&
      containsMarkdocTagInUrl(token.content, options.validatedProtocols)
    ) {
      if (!token.errors) token.errors = [];
      token.errors.push({
        id: 'href-format-invalid',
        level: 'error',
        message:
          "The 'href' format cannot contain Markdoc tag or variable. URLs must be static strings.",
      });
    }

    const errors = token.errors || [];
    const meta = token.meta;
    const tag = meta ? meta.tag : undefined;

    if (type === T.ANNOTATION) {
      parent.addError({
        id: 'no-inline-annotations',
        level: 'error',
        message: `Can't apply inline annotations to '${parent.type}'`,
      });
      return;
    }

    const typeName = NODE_TYPE[type];
    const nesting = NESTING[type];

    if (type === T.ERROR) {
      const { message, location } = meta.error;
      errors.push({ id: 'parse-error', level: 'critical', message, location });
    }

    if (nesting < 0) {
      if (parent.type === typeName && parent.tag === tag) {
        // Extend the container's location to cover its closing token. Without
        // this, a multi-line construct (notably a markdoc `{% tag %}` block)
        // would report `location.end` as the end of its *opening* token.
        if (locate && token.map0 >= 0 && parent.location)
          parent.location.end = {
            line: token.map1,
            character: parent.location.end.character,
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

    // Compact mode: don't materialize the inline wrapper Node — recurse
    // children straight into the surrounding parent (paragraph/heading/etc.).
    if (compact && type === T.INLINE) {
      const start = parseInline(token);
      const tokens = inline.pool;
      for (let i = start; i < inline.length; i++)
        handleInline(tokens[i], parent);
      return;
    }

    const node = new Node(
      typeName as any,
      blockAttributes(token),
      undefined,
      tag || undefined
    );

    if (errors.length) for (const e of errors) node.addError(e);

    if (locate) node.location = location(token.map0, token.map1, parent);

    const attributes = meta ? meta.attributes : undefined;
    if (attributes && (typeName === 'tag' || typeName === 'fence'))
      annotate(node, attributes);

    place(node, parent, tag);

    if (nesting > 0) nodes.push(node);

    if (type === T.INLINE) {
      nodes.push(node);
      const start = parseInline(token);
      const tokens = inline.pool;
      for (let i = start; i < inline.length; i++)
        handleInline(tokens[i], parent);
      nodes.pop();
    } else if (fenceChildren) {
      nodes.push(node);
      for (const child of fenceChildren) {
        if (child.meta?.tag === 'table') sawTable = true;
        handleObjectToken(
          child,
          nodes,
          file,
          handleSlots,
          addLocation,
          compact,
          undefined
        );
      }
      nodes.pop();
    }
  }

  for (let i = 0; i < length; i++) {
    if (i <= skipUntil) continue;
    const token = pool[i];

    if (
      options.githubAdmonitions &&
      token.type === T.BLOCKQUOTE_OPEN &&
      i + 3 < length &&
      pool[i + 1].type === T.PARAGRAPH_OPEN &&
      pool[i + 2].type === T.INLINE &&
      pool[i + 3].type === T.PARAGRAPH_CLOSE
    ) {
      const content = pool[i + 2].content;
      const match = ADMONITION_RE.exec(content);
      const kind = match ? match[1].toLowerCase() : '';
      if (match && ADMONITION_KIND_SET.has(kind)) {
        token.str = kind;
        if (content.length === match[0].length) {
          // Only the marker, no body — remove the marker paragraph entirely.
          skipUntil = i + 3;
        } else {
          // Markdoc keeps the original children after the first line break.
          sliceInline = pool[i + 2];
        }
      }
    }

    handleBlock(token);
  }

  if (nodes.length > 1)
    for (const node of nodes.slice(1))
      node.addError({
        id: 'missing-closing',
        level: 'critical',
        message: `Node '${node.tag || node.type}' is missing closing`,
      });

  for (const transform of transforms)
    if (transform !== tableTransform || sawTable) transform(doc, args);

  return doc;
}
