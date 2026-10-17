/**
 * A Markdoc parser that goes straight from source text to Markdoc Nodes, with
 * no markdown-it tokens in between.
 *
 * It implements the same grammar as `Tokenizer` + `parse` — markdown-it
 * 12.3.2 with Markdoc's plugins and indentation patch — and produces the same
 * AST. The speed comes from the machinery: line offsets in reused typed
 * arrays, pooled tokens instead of `Token` objects, first-character rule
 * dispatch, and building Nodes directly.
 */
import Node from '../ast/node';
import { BlockState } from './block';
import { InlineState } from './inline';
import { build } from './build';

import type { ParserArgs } from '../types';

export type FastParseOptions = {
  /** markdown-it's `html` option: recognize raw HTML. */
  html?: boolean;
  allowIndentation?: boolean;
  allowComments?: boolean;
  allowLinkValidation?: boolean;
  linkValidationOptions?: { validatedProtocols: string[] };
  githubAdmonitions?: boolean;
};

type Parser = {
  block: BlockState;
  inline: InlineState;
  busy: boolean;
};

const parsers = new Map<number, Parser>();

function parserFor(options: FastParseOptions): Parser {
  const key =
    (options.html ? 1 : 0) |
    (options.allowIndentation ? 2 : 0) |
    (options.allowComments ? 4 : 0);
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
  if (src.indexOf('\0') >= 0) src = src.replace(NULL_RE, '�');
  return src;
}

/** Parses `source` like `Markdoc.parse(new Tokenizer(options).tokenize(source), args)`. */
export function parseDocument(
  source: string,
  options: FastParseOptions = {},
  args?: string | ParserArgs
): Node {
  if (typeof args === 'string') args = { file: args };

  const parser = parserFor(options);
  parser.busy = true;
  try {
    parser.block.reset(normalize(String(source)));
    parser.block.tokenize(0, parser.block.lineMax);
    return build(
      parser.block,
      parser.inline,
      {
        allowLinkValidation: !!options.allowLinkValidation,
        validatedProtocols: options.linkValidationOptions
          ?.validatedProtocols ?? ['http', 'https'],
        githubAdmonitions: options.githubAdmonitions !== false,
      },
      args
    );
  } finally {
    parser.busy = false;
  }
}

/** Like `Markdoc.parse(source, args)` for a string, including compact unwrapping. */
export function fastParse(
  source: string,
  options: FastParseOptions = {},
  args?: string | ParserArgs
): Node {
  const doc = parseDocument(source, options, args);

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
