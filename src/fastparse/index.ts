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
    (options.linkify ? 8 : 0);
  let parser = parsers.get(key);
  if (!parser || parser.busy) {
    const created = {
      block: new BlockState({
        html: !!options.html,
        allowIndentation: !!options.allowIndentation,
        allowComments: !!options.allowComments,
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
    return build(
      parser.block,
      parser.inline,
      {
        allowLinkValidation: !!args.allowLinkValidation,
        validatedProtocols: args.linkValidationOptions?.validatedProtocols ?? [
          'http',
          'https',
        ],
        githubAdmonitions: args.githubAdmonitions !== false,
        html: typeof args.html === 'object' ? args.html : undefined,
      },
      args
    );
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
