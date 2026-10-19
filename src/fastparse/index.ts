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
import type { HeadingStop } from './block';
import { InlineState } from './inline';
import { build } from './build';
import * as T from './tokens';

import type { ParserArgs } from '../types';

type Parser = {
  key: number;
  block: BlockState;
  inline: InlineState;
  busy: boolean;
};

const parsers = new Map<number, Parser>();

// A parser that grew past these is not kept for the next document, so one
// very large document does not hold on to its memory for good.
const MAX_KEPT_TOKENS = 1 << 16;
const MAX_KEPT_LINES = 1 << 17;

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
      key,
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
  parser.busy = true;
  return parser;
}

function release(parser: Parser) {
  parser.busy = false;
  if (
    parser.block.pool.length > MAX_KEPT_TOKENS ||
    parser.inline.pool.length > MAX_KEPT_TOKENS ||
    parser.block.bMarks.length > MAX_KEPT_LINES
  ) {
    if (parsers.get(parser.key) === parser) parsers.delete(parser.key);
  }
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
  try {
    parser.block.reset(normalize(String(source)));
    parser.block.tokenize(0, parser.block.lineMax);
    return build(parser.block, parser.inline, buildOptions(args), args);
  } finally {
    release(parser);
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
   * Called with each Markdoc tag that a heading could be inside; a heading
   * inside a tag it returns `true` for does not count. It must decide from
   * the tag's name and attributes (`tag.tag`, `tag.attributes`): the Node it
   * gets has no children or location yet, as the parse has not reached them.
   * With `slots`, headings in slots never count, as slots are not part of the
   * document's children.
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
  args: string | FirstHeadingOptions = {}
): Node | undefined {
  if (typeof args === 'string') args = { file: args };
  source = String(source);
  const parser = parserFor(args);
  const block = parser.block;
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
      const stop: HeadingStop = {
        skip: args.skip,
        slots: !!args.slots,
        open: [],
        skipped: 0,
        found: -1,
      };
      block.stop = stop;
      try {
        block.tokenize(0, block.lineMax);
      } finally {
        block.stop = null;
      }
      const found = stop.found;

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
      // as its children. So do HTML blocks' elements under an HTML handler,
      // which matters when such an element could be skipped or keep a slot
      // open. When such content comes before the heading, the full parse
      // decides. It also does for a heading in a table, which the table
      // transform rewrites.
      if (
        mayLeak(
          block,
          found - 2,
          (!!args.skip || !!args.slots) && typeof args.html === 'object'
        ) ||
        stop.open.some((open) => open.tag === 'table')
      )
        break;

      // heading_open, inline, heading_close
      const range = { from: found - 2, to: found + 1, unclosed: false };
      const doc = build(block, parser.inline, buildOptions(args), args, range);
      // A tag left open in the heading would hold the blocks after it, and a
      // link reference the parse has not reached may be defined after it.
      if (range.unclosed || parser.inline.missedReference) break;
      return doc.children[0];
    }
  } finally {
    release(parser);
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
