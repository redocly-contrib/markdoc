/**
 * Token kinds of the fast parser. They mirror markdown-it's token types one to
 * one (plus the types Markdoc's plugins add), as small integers so the parser
 * can compare and switch on them cheaply.
 */
export const TEXT = 0;
export const PARAGRAPH_OPEN = 1;
export const PARAGRAPH_CLOSE = 2;
export const INLINE = 3;
export const HEADING_OPEN = 4;
export const HEADING_CLOSE = 5;
export const HR = 6;
export const FENCE = 7;
export const BLOCKQUOTE_OPEN = 8;
export const BLOCKQUOTE_CLOSE = 9;
export const BULLET_LIST_OPEN = 10;
export const BULLET_LIST_CLOSE = 11;
export const ORDERED_LIST_OPEN = 12;
export const ORDERED_LIST_CLOSE = 13;
export const LIST_ITEM_OPEN = 14;
export const LIST_ITEM_CLOSE = 15;
export const TABLE_OPEN = 16;
export const TABLE_CLOSE = 17;
export const THEAD_OPEN = 18;
export const THEAD_CLOSE = 19;
export const TBODY_OPEN = 20;
export const TBODY_CLOSE = 21;
export const TR_OPEN = 22;
export const TR_CLOSE = 23;
export const TH_OPEN = 24;
export const TH_CLOSE = 25;
export const TD_OPEN = 26;
export const TD_CLOSE = 27;
export const HTML_BLOCK = 28;
export const COMMENT = 29;
export const FRONTMATTER = 30;
export const TAG_OPEN = 31;
export const TAG_CLOSE = 32;
export const TAG = 33;
export const ANNOTATION = 34;
export const VARIABLE = 35;
export const ERROR = 36;
export const SOFTBREAK = 37;
export const HARDBREAK = 38;
export const CODE_INLINE = 39;
export const EM_OPEN = 40;
export const EM_CLOSE = 41;
export const STRONG_OPEN = 42;
export const STRONG_CLOSE = 43;
export const S_OPEN = 44;
export const S_CLOSE = 45;
export const LINK_OPEN = 46;
export const LINK_CLOSE = 47;
export const IMAGE = 48;
export const HTML_INLINE = 49;

const KINDS = 50;

/** `nesting` of each kind, as markdown-it sets it. */
export const NESTING = new Int8Array(KINDS);

/**
 * The Markdoc node type each kind becomes: markdown-it's type without its
 * `_open`/`_close` suffix, then Markdoc's `mappings` (`bullet_list` -> `list`,
 * `list_item` -> `item`, `code_inline` -> `code`, `variable` -> `text`).
 */
export const NODE_TYPE: string[] = new Array(KINDS);

function kind(code: number, type: string, nesting: number) {
  NESTING[code] = nesting;
  NODE_TYPE[code] = type;
}

kind(TEXT, 'text', 0);
kind(PARAGRAPH_OPEN, 'paragraph', 1);
kind(PARAGRAPH_CLOSE, 'paragraph', -1);
kind(INLINE, 'inline', 0);
kind(HEADING_OPEN, 'heading', 1);
kind(HEADING_CLOSE, 'heading', -1);
kind(HR, 'hr', 0);
kind(FENCE, 'fence', 0);
kind(BLOCKQUOTE_OPEN, 'blockquote', 1);
kind(BLOCKQUOTE_CLOSE, 'blockquote', -1);
kind(BULLET_LIST_OPEN, 'list', 1);
kind(BULLET_LIST_CLOSE, 'list', -1);
kind(ORDERED_LIST_OPEN, 'list', 1);
kind(ORDERED_LIST_CLOSE, 'list', -1);
kind(LIST_ITEM_OPEN, 'item', 1);
kind(LIST_ITEM_CLOSE, 'item', -1);
kind(TABLE_OPEN, 'table', 1);
kind(TABLE_CLOSE, 'table', -1);
kind(THEAD_OPEN, 'thead', 1);
kind(THEAD_CLOSE, 'thead', -1);
kind(TBODY_OPEN, 'tbody', 1);
kind(TBODY_CLOSE, 'tbody', -1);
kind(TR_OPEN, 'tr', 1);
kind(TR_CLOSE, 'tr', -1);
kind(TH_OPEN, 'th', 1);
kind(TH_CLOSE, 'th', -1);
kind(TD_OPEN, 'td', 1);
kind(TD_CLOSE, 'td', -1);
kind(HTML_BLOCK, 'html_block', 0);
kind(COMMENT, 'comment', 0);
kind(FRONTMATTER, 'frontmatter', 0);
kind(TAG_OPEN, 'tag', 1);
kind(TAG_CLOSE, 'tag', -1);
kind(TAG, 'tag', 0);
kind(ANNOTATION, 'annotation', 0);
kind(VARIABLE, 'text', 0);
kind(ERROR, 'error', 0);
kind(SOFTBREAK, 'softbreak', 0);
kind(HARDBREAK, 'hardbreak', 0);
kind(CODE_INLINE, 'code', 0);
kind(EM_OPEN, 'em', 1);
kind(EM_CLOSE, 'em', -1);
kind(STRONG_OPEN, 'strong', 1);
kind(STRONG_CLOSE, 'strong', -1);
kind(S_OPEN, 's', 1);
kind(S_CLOSE, 's', -1);
kind(LINK_OPEN, 'link', 1);
kind(LINK_CLOSE, 'link', -1);
kind(IMAGE, 'image', 0);
kind(HTML_INLINE, 'html_inline', 0);

/** Markdoc tag-grammar result types, as token kinds. */
export function grammarKind(type: string): number {
  switch (type) {
    case 'tag_open':
      return TAG_OPEN;
    case 'tag_close':
      return TAG_CLOSE;
    case 'tag':
      return TAG;
    case 'annotation':
      return ANNOTATION;
    case 'variable':
      return VARIABLE;
    default:
      return ERROR;
  }
}

/**
 * A block token. Instances are pooled and reused across documents, so a parse
 * allocates no token objects once the pool is warm.
 */
export class BlockToken {
  type = 0;
  level = 0;
  /** `map`, or -1 for none. */
  map0 = -1;
  map1 = -1;
  content = '';
  info = '';
  markup = '';
  /** Heading level, or an ordered list's start number. */
  num = 0;
  /** Blockquote admonition kind, or a table cell's alignment. */
  str = '';
  meta: any = null;
  errors: any[] | null = null;
  hidden = false;
}

export type Delimiter = {
  marker: number;
  length: number;
  token: number;
  end: number;
  open: boolean;
  close: boolean;
};

/** An inline token, pooled like `BlockToken`. */
export class InlineToken {
  type = 0;
  level = 0;
  content = '';
  info = '';
  markup = '';
  href = '';
  title = '';
  meta: any = null;
  /** `tokens_meta[i].delimiters` for opening tokens, else null. */
  delimiters: Delimiter[] | null = null;
}
