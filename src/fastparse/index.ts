/**
 * Markdoc's parser: source text straight to Markdoc Nodes.
 *
 * The grammar is markdown-it 12.3.2's (CommonMark plus tables and
 * strikethrough) with Markdoc's tags, annotations and indentation rules,
 * and the AST is the one Markdoc has always produced from it. The machinery
 * is its own: line offsets in reused typed arrays, pooled tokens, first-
 * character rule dispatch, and Nodes built directly.
 */
import Node from '../ast/node';
import { BlockState } from './block';
import { InlineState } from './inline';
import { build } from './build';
import * as T from './tokens';

import type { ParserArgs } from '../types';

type Parser = {
  block: BlockState;
  inline: InlineState;
  busy: boolean;
};

const parsers = new Map<number, Parser>();

function parserFor(options: ParserArgs): Parser {
  const key =
    (options.html ? 1 : 0) |
    (options.allowIndentation ? 2 : 0) |
    (options.allowComments ? 4 : 0) |
    (options.linkify ? 8 : 0) |
    (options.frontmatter === false ? 16 : 0);
  let parser = parsers.get(key);
  if (!parser || parser.busy) {
    const created = {
      block: new BlockState({
        html: !!options.html,
        allowIndentation: !!options.allowIndentation,
        allowComments: !!options.allowComments,
        frontmatter: options.frontmatter !== false,
      }),
      inline: new InlineState({
        html: !!options.html,
        allowComments: !!options.allowComments,
        linkify: !!options.linkify,
      }),
      busy: false,
    };
    // A parse that re-enters (from a schema or plugin callback) gets a fresh
    // state rather than clobbering the one in use.
    if (!parser) parsers.set(key, created);
    parser = created;
  }
  return parser;
}

const NEWLINES_RE = /\r\n?|\n/g;
const NULL_RE = /\0/g;

/** markdown-it's core `normalize` rule. */
function normalize(src: string) {
  if (src.indexOf('\r') >= 0) src = src.replace(NEWLINES_RE, '\n');
  if (src.indexOf('\0') >= 0) src = src.replace(NULL_RE, '\uFFFD');
  return src;
}

function buildOptions(args: ParserArgs) {
  return {
    allowLinkValidation: !!args.allowLinkValidation,
    validatedProtocols: args.linkValidationOptions?.validatedProtocols ?? [
      'http',
      'https',
    ],
    githubAdmonitions: args.githubAdmonitions !== false,
    html: typeof args.html === 'object' ? args.html : undefined,
  };
}

/** Parses `source` into a `document` Node. */
export function parseDocument(
  source: string,
  args: string | ParserArgs = {}
): Node {
  if (typeof args === 'string') args = { file: args };

  const parser = parserFor(args);
  parser.busy = true;
  try {
    parser.block.reset(normalize(String(source)));
    parser.block.tokenize(0, parser.block.lineMax);
    return build(parser.block, parser.inline, buildOptions(args), args);
  } finally {
    parser.busy = false;
  }
}

/** `parseDocument`, then compact mode's unwrapping of a single-child document. */
export function parse(source: string, args?: string | ParserArgs): Node {
  const doc = parseDocument(source, args);

  const opts = typeof args === 'object' ? args : undefined;
  if (
    opts?.compact &&
    doc.type === 'document' &&
    doc.children.length === 1 &&
    !Object.keys(doc.slots ?? {}).length &&
    !doc.errors?.length &&
    !doc.children[0].errors?.length &&
    !doc.attributes.frontmatter
  ) {
    return doc.children[0];
  }

  return doc;
}

const FIRST_WINDOW = 1024;
const WINDOW_GROWTH = 8;

export type FirstHeadingOptions = ParserArgs & {
  /**
   * Called with each Markdoc tag (as a Node with its attributes) that a
   * heading could be inside; a heading inside a tag it returns `true` for does
   * not count. With `slots`, headings in slots never count, as slots are not
   * part of the document's children.
   */
  skip?: (tag: Node) => boolean;
};

/**
 * The first heading of `findFirstHeading(parse(source, options), skip)`,
 * found without parsing the rest of the document: block parsing stops at the
 * heading, and only the heading becomes Nodes. Its cost grows with the text
 * before the heading, not with the document.
 *
 * The result is the Node the full parse would hold. (When the heading uses a
 * link reference that is not defined before it, the whole document is parsed
 * to find the definition.)
 */
export function parseFirstHeading(
  source: string,
  args: FirstHeadingOptions = {}
): Node | undefined {
  source = String(source);
  const parser = parserFor(args);
  const block = parser.block;
  parser.busy = true;
  try {
    // Index and parse a window at the start of the document, growing it
    // until the heading is found well inside it, or the window is the
    // whole document. Most headings are near the top.
    for (let limit = FIRST_WINDOW; ; limit *= WINDOW_GROWTH) {
      const windowed = limit < source.length;
      block.reset(
        normalize(windowed ? source.slice(0, limit) : source),
        windowed
      );
      block.stop = {
        skip: args.skip,
        slots: !!args.slots,
        open: [],
        skipped: 0,
        found: -1,
      };
      let found: number;
      try {
        block.tokenize(0, block.lineMax);
      } finally {
        found = block.stop.found;
        block.stop = null;
      }

      if (block.windowed) {
        // A heading's next line decides whether it is a table header, and
        // the window's last line may be cut short, so the heading must not
        // be one of the window's last two lines.
        const settled =
          found >= 0 &&
          !block.overflow &&
          block.pool[found - 2].map0 + 2 < block.lineMax;
        if (!settled) continue;
      }

      if (found < 0) return undefined;

      // Markdoc tags inside fences and paragraphs become Nodes too, and one
      // left open there holds every later block — this heading included —
      // as its children. So do HTML elements under an HTML handler. When
      // such content comes before the heading, the full parse decides.
      if (
        mayLeak(block, found - 2, !!args.skip && typeof args.html === 'object')
      )
        break;

      // heading_open, inline, heading_close
      const doc = build(
        block,
        parser.inline,
        buildOptions(args),
        args,
        found - 2,
        found + 1
      );
      if (!parser.inline.missedReference) return doc.children[0];
      // The heading looks up a link reference the parse has not reached.
      break;
    }
  } finally {
    parser.busy = false;
  }
  return findFirstHeading(parse(source, args), args.skip);
}

/** Whether content before `end` could leave a Node open over later blocks. */
function mayLeak(block: BlockState, end: number, html: boolean): boolean {
  const pool = block.pool;
  for (let i = 0; i < end; i++) {
    const token = pool[i];
    if (
      ((token.type === T.INLINE || token.type === T.FENCE) &&
        token.content.indexOf('{%') !== -1) ||
      (html && token.type === T.HTML_BLOCK)
    )
      return true;
  }
  return false;
}

/**
 * The first heading in `node` — `node` itself, or depth first in document
 * order among its children — not inside a tag `skip` returns `true` for.
 * Slots are not searched.
 */
export function findFirstHeading(
  node: Node,
  skip?: (tag: Node) => boolean
): Node | undefined {
  if (node.type === 'heading') return node;
  if (node.type === 'tag' && skip?.(node)) return undefined;
  for (const child of node.children) {
    const heading = findFirstHeading(child, skip);
    if (heading) return heading;
  }
  return undefined;
}
