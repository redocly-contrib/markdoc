/**
 * Block-level parsing: a port of markdown-it 12.3.2's block rules (with the
 * `allowIndentation` patch Markdoc applies) and of Markdoc's block plugins
 * (tags, comments, frontmatter), producing the same token sequence.
 *
 * What differs from markdown-it is the machinery, not the grammar:
 *  - line offsets live in typed arrays that are reused across documents, and
 *    are found with `indexOf('\n')` instead of a loop over every character;
 *  - tokens come from a pool of reused objects instead of `new Token()`;
 *  - rules are plain functions in fixed arrays instead of a `Ruler`.
 */
import MarkdownIt from 'markdown-it/lib';
import htmlBlockNames from 'markdown-it/lib/common/html_blocks';
import { HTML_OPEN_CLOSE_TAG_RE } from 'markdown-it/lib/common/html_re';
import { findTagEnd, OPEN, CLOSE } from '../utils';
import { parse as parseTag, SyntaxError } from '../grammar/tag';
import Variable from '../ast/variable';
import Function from '../ast/function';
import * as T from './tokens';
import { BlockToken, NESTING, grammarKind } from './tokens';

/** Only for its link helpers; never used to parse. */
export const md = new MarkdownIt();
const { normalizeReference } = md.utils;

export type BlockOptions = {
  html: boolean;
  allowIndentation: boolean;
  allowComments: boolean;
};

type Rule = (
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
) => boolean;

const MAX_NESTING = 100;

function isSpace(code: number) {
  return code === 0x09 || code === 0x20;
}

/** JS `String.prototype.trim` whitespace, for the tag rule's quirk below. */
function isTrimmable(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export class BlockState {
  src = '';
  bMarks = new Int32Array(1024);
  eMarks = new Int32Array(1024);
  tShift = new Int32Array(1024);
  sCount = new Int32Array(1024);
  bsCount = new Int32Array(1024);

  blkIndent = 0;
  line = 0;
  lineMax = 0;
  tight = false;
  listIndent = -1;
  parentType = 'root';
  level = 0;

  pool: BlockToken[] = [];
  length = 0;

  references: Record<string, { title: string; href: string }> | undefined;

  html: boolean;
  allowIndentation: boolean;

  /** Index of the document's first non-whitespace character (see `tag`). */
  firstNonSpace = 0;

  rules: Rule[];
  paragraphTerminators: Rule[];
  referenceTerminators: Rule[];
  blockquoteTerminators: Rule[];
  listTerminators: Rule[];

  constructor(options: BlockOptions) {
    this.html = options.html;
    this.allowIndentation = options.allowIndentation;
    // markdown-it's rule order after Markdoc's plugins are registered, with
    // `code` and `lheading` disabled; each terminator list is the rules
    // whose `alt` names that block, in the same order.
    const comments = options.allowComments ? [comment] : [];
    this.rules = [
      ...comments,
      table,
      fence,
      blockquote,
      frontmatter,
      hr,
      list,
      reference,
      htmlBlock,
      heading,
      tag,
      paragraph,
    ];
    this.paragraphTerminators = [
      ...comments,
      table,
      fence,
      blockquote,
      hr,
      list,
      htmlBlock,
      heading,
      tag,
    ];
    this.referenceTerminators = [
      table,
      fence,
      blockquote,
      hr,
      list,
      htmlBlock,
      heading,
    ];
    this.blockquoteTerminators = [
      fence,
      blockquote,
      hr,
      list,
      htmlBlock,
      heading,
      tag,
    ];
    this.listTerminators = [fence, blockquote, hr];
  }

  /** Resets the state for `src` and indexes its lines. */
  reset(src: string) {
    this.src = src;
    this.blkIndent = 0;
    this.line = 0;
    this.tight = false;
    this.listIndent = -1;
    this.parentType = 'root';
    this.level = 0;
    this.length = 0;
    this.references = undefined;

    const len = src.length;
    let first = 0;
    while (first < len && isTrimmable(src.charCodeAt(first))) first++;
    this.firstNonSpace = first;

    // Same lines as markdown-it's StateBlock constructor. Note its quirk: a
    // last line holding only spaces and tabs, with no newline after it, is
    // not a line at all.
    let lines = 0;
    let start = 0;
    while (start < len) {
      let pos = start;
      let indent = 0;
      let offset = 0;
      for (; pos < len; pos++) {
        const ch = src.charCodeAt(pos);
        if (ch === 0x20) {
          indent++;
          offset++;
        } else if (ch === 0x09) {
          indent++;
          offset += 4 - (offset % 4);
        } else break;
      }
      if (pos >= len) break;
      const newline = src.indexOf('\n', pos);
      const end = newline === -1 ? len : newline;
      if (lines + 2 > this.bMarks.length) this.grow(lines + 2);
      this.bMarks[lines] = start;
      this.eMarks[lines] = end;
      this.tShift[lines] = indent;
      this.sCount[lines] = offset;
      this.bsCount[lines] = 0;
      lines++;
      start = end + 1;
    }
    if (lines + 1 > this.bMarks.length) this.grow(lines + 1);
    this.bMarks[lines] = len;
    this.eMarks[lines] = len;
    this.tShift[lines] = 0;
    this.sCount[lines] = 0;
    this.bsCount[lines] = 0;
    this.lineMax = lines;
  }

  private grow(min: number) {
    let size = this.bMarks.length * 2;
    while (size < min) size *= 2;
    const grow = (a: Int32Array) => {
      const b = new Int32Array(size);
      b.set(a);
      return b;
    };
    this.bMarks = grow(this.bMarks);
    this.eMarks = grow(this.eMarks);
    this.tShift = grow(this.tShift);
    this.sCount = grow(this.sCount);
    this.bsCount = grow(this.bsCount);
  }

  push(type: number): BlockToken {
    let token = this.pool[this.length];
    if (token === undefined) {
      token = new BlockToken();
      this.pool.push(token);
    } else {
      token.map0 = -1;
      token.map1 = -1;
      token.content = '';
      token.info = '';
      token.markup = '';
      token.num = 0;
      token.str = '';
      token.meta = null;
      token.errors = null;
      token.hidden = false;
    }
    token.type = type;
    const nesting = NESTING[type];
    if (nesting < 0) this.level--;
    token.level = this.level;
    if (nesting > 0) this.level++;
    this.length++;
    return token;
  }

  isEmpty(line: number) {
    return this.bMarks[line] + this.tShift[line] >= this.eMarks[line];
  }

  skipEmptyLines(from: number) {
    for (const max = this.lineMax; from < max; from++) {
      if (this.bMarks[from] + this.tShift[from] < this.eMarks[from]) break;
    }
    return from;
  }

  skipSpaces(pos: number) {
    const src = this.src;
    for (const max = src.length; pos < max; pos++) {
      if (!isSpace(src.charCodeAt(pos))) break;
    }
    return pos;
  }

  skipSpacesBack(pos: number, min: number) {
    if (pos <= min) return pos;
    while (pos > min) {
      if (!isSpace(this.src.charCodeAt(--pos))) return pos + 1;
    }
    return pos;
  }

  skipChars(pos: number, code: number) {
    const src = this.src;
    for (const max = src.length; pos < max; pos++) {
      if (src.charCodeAt(pos) !== code) break;
    }
    return pos;
  }

  skipCharsBack(pos: number, code: number, min: number) {
    if (pos <= min) return pos;
    while (pos > min) {
      if (code !== this.src.charCodeAt(--pos)) return pos + 1;
    }
    return pos;
  }

  getLines(begin: number, end: number, indent: number, keepLastLF: boolean) {
    if (begin >= end) return '';
    const src = this.src;

    // Common case: no indent to strip, so each line is a plain slice. When the
    // lines are also contiguous in the source, that is one slice in total.
    if (indent === 0) {
      let contiguous = true;
      for (let line = begin + 1; line < end; line++) {
        if (this.bMarks[line] !== this.eMarks[line - 1] + 1) {
          contiguous = false;
          break;
        }
      }
      if (contiguous)
        return src.slice(
          this.bMarks[begin],
          this.eMarks[end - 1] + (keepLastLF ? 1 : 0)
        );
    }

    let out = '';
    for (let line = begin; line < end; line++) {
      let lineIndent = 0;
      const lineStart = this.bMarks[line];
      let first = lineStart;
      const last =
        line + 1 < end || keepLastLF
          ? this.eMarks[line] + 1
          : this.eMarks[line];

      while (first < last && lineIndent < indent) {
        const ch = src.charCodeAt(first);
        if (isSpace(ch)) {
          if (ch === 0x09) {
            lineIndent += 4 - ((lineIndent + this.bsCount[line]) % 4);
          } else {
            lineIndent++;
          }
        } else if (first - lineStart < this.tShift[line]) {
          // patched tShift masked characters to look like spaces (blockquotes, list markers)
          lineIndent++;
        } else {
          break;
        }
        first++;
      }

      if (lineIndent > indent) {
        // partially expanding tabs in code blocks, e.g '\t\tfoobar'
        // with indent=2 becomes '  \tfoobar'
        out += ' '.repeat(lineIndent - indent) + src.slice(first, last);
      } else {
        out += src.slice(first, last);
      }
    }
    return out;
  }

  /** markdown-it's `ParserBlock#tokenize`. */
  tokenize(startLine: number, endLine: number) {
    const rules = this.rules;
    const len = rules.length;
    let line = startLine;
    let hasEmptyLines = false;

    while (line < endLine) {
      this.line = line = this.skipEmptyLines(line);
      if (line >= endLine) break;

      // Termination condition for nested calls.
      if (this.sCount[line] < this.blkIndent) break;

      if (this.level >= MAX_NESTING) {
        this.line = endLine;
        break;
      }

      for (let i = 0; i < len; i++) {
        if (rules[i](this, line, endLine, false)) break;
      }

      this.tight = !hasEmptyLines;

      if (this.isEmpty(this.line - 1)) hasEmptyLines = true;

      line = this.line;

      if (line < endLine && this.isEmpty(line)) {
        hasEmptyLines = true;
        line++;
        this.line = line;
      }
    }
  }
}

function terminates(
  rules: Rule[],
  state: BlockState,
  line: number,
  endLine: number
) {
  for (let i = 0; i < rules.length; i++) {
    if (rules[i](state, line, endLine, true)) return true;
  }
  return false;
}

/** `sCount - blkIndent >= 4` would make this an indented code block. */
function indentedCode(state: BlockState, line: number) {
  return !state.allowIndentation && state.sCount[line] - state.blkIndent >= 4;
}

// ---------------------------------------------------------------- paragraph

function paragraph(state: BlockState, startLine: number): boolean {
  const terminators = state.paragraphTerminators;
  const endLine = state.lineMax;
  let nextLine = startLine + 1;
  const oldParentType = state.parentType;
  state.parentType = 'paragraph';

  for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
    // this would be a code block normally, but after paragraph
    // it's considered a lazy continuation regardless of what's there
    if (!state.allowIndentation && state.sCount[nextLine] - state.blkIndent > 3)
      continue;

    // quirk for blockquotes, this line should already be checked by that rule
    if (state.sCount[nextLine] < 0) continue;

    if (terminates(terminators, state, nextLine, endLine)) break;
  }

  const content = state
    .getLines(startLine, nextLine, state.blkIndent, false)
    .trim();

  state.line = nextLine;

  let token = state.push(T.PARAGRAPH_OPEN);
  token.map0 = startLine;
  token.map1 = state.line;

  token = state.push(T.INLINE);
  token.content = content;
  token.map0 = startLine;
  token.map1 = state.line;

  state.push(T.PARAGRAPH_CLOSE);

  state.parentType = oldParentType;
  return true;
}

// ---------------------------------------------------------------- heading

const HEADING_MARKUP = '########';

function heading(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];

  if (indentedCode(state, startLine)) return false;

  let ch = src.charCodeAt(pos);
  if (ch !== 0x23 /* # */ || pos >= max) return false;

  // count heading level
  let level = 1;
  ch = src.charCodeAt(++pos);
  while (ch === 0x23 /* # */ && pos < max && level <= 6) {
    level++;
    ch = src.charCodeAt(++pos);
  }

  if (level > 6 || (pos < max && !isSpace(ch))) return false;

  if (silent) return true;

  // Let's cut tails like '    ###  ' from the end of string
  max = state.skipSpacesBack(max, pos);
  const tmp = state.skipCharsBack(max, 0x23, pos); // #
  if (tmp > pos && isSpace(src.charCodeAt(tmp - 1))) max = tmp;

  state.line = startLine + 1;

  let token = state.push(T.HEADING_OPEN);
  token.num = level;
  token.markup = HEADING_MARKUP.slice(0, level);
  token.map0 = startLine;
  token.map1 = state.line;

  token = state.push(T.INLINE);
  token.content = src.slice(pos, max).trim();
  token.map0 = startLine;
  token.map1 = state.line;

  token = state.push(T.HEADING_CLOSE);
  token.num = level;
  token.markup = HEADING_MARKUP.slice(0, level);

  return true;
}

// ---------------------------------------------------------------- hr

function hr(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];

  if (indentedCode(state, startLine)) return false;

  const marker = src.charCodeAt(pos++);

  // Check hr marker
  if (
    marker !== 0x2a /* * */ &&
    marker !== 0x2d /* - */ &&
    marker !== 0x5f /* _ */
  )
    return false;

  // markers can be mixed with spaces, but there should be at least 3 of them
  let cnt = 1;
  while (pos < max) {
    const ch = src.charCodeAt(pos++);
    if (ch !== marker && !isSpace(ch)) return false;
    if (ch === marker) cnt++;
  }

  if (cnt < 3) return false;

  if (silent) return true;

  state.line = startLine + 1;

  const token = state.push(T.HR);
  token.map0 = startLine;
  token.map1 = state.line;
  token.markup = String.fromCharCode(marker).repeat(cnt);

  return true;
}

// ---------------------------------------------------------------- fence

function fence(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  let haveEndMarker = false;

  if (indentedCode(state, startLine)) return false;

  if (pos + 3 > max) return false;

  const marker = src.charCodeAt(pos);

  if (marker !== 0x7e /* ~ */ && marker !== 0x60 /* ` */) return false;

  // scan marker length
  let mem = pos;
  pos = state.skipChars(pos, marker);

  let len = pos - mem;

  if (len < 3) return false;

  const markup = src.slice(mem, pos);
  const params = src.slice(pos, max);

  if (marker === 0x60 /* ` */) {
    if (params.indexOf('`') >= 0) return false;
  }

  // Since start is found, we can report success here in validation mode
  if (silent) return true;

  // search end of block
  let nextLine = startLine;

  for (;;) {
    nextLine++;
    if (nextLine >= endLine) {
      // unclosed block should be autoclosed by end of document.
      // also block seems to be autoclosed by end of parent
      break;
    }

    pos = mem = state.bMarks[nextLine] + state.tShift[nextLine];
    max = state.eMarks[nextLine];

    if (pos < max && state.sCount[nextLine] < state.blkIndent) {
      // non-empty line with negative indent should stop the list:
      // - ```
      //  test
      break;
    }

    if (src.charCodeAt(pos) !== marker) continue;

    if (indentedCode(state, nextLine)) {
      // closing fence should be indented less than 4 spaces
      continue;
    }

    pos = state.skipChars(pos, marker);

    // closing code fence must be at least as long as the opening one
    if (pos - mem < len) continue;

    // make sure tail has spaces only
    pos = state.skipSpaces(pos);

    if (pos < max) continue;

    haveEndMarker = true;
    // found!
    break;
  }

  // If a fence has heading spaces, they should be removed from its inner block
  len = state.sCount[startLine];

  state.line = nextLine + (haveEndMarker ? 1 : 0);

  const token = state.push(T.FENCE);
  token.info = params;
  token.content = state.getLines(startLine + 1, nextLine, len, true);
  token.markup = markup;
  token.map0 = startLine;
  token.map1 = state.line;

  return true;
}

// ---------------------------------------------------------------- blockquote

function blockquote(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  const oldLineMax = state.lineMax;
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  let adjustTab: boolean;
  let spaceAfterMarker: boolean;
  let initial: number;
  let offset: number;
  let ch: number;

  if (indentedCode(state, startLine)) return false;

  // check the block quote marker
  if (src.charCodeAt(pos++) !== 0x3e /* > */) return false;

  // we know that it's going to be a valid blockquote,
  // so no point trying to find the end of it in silent mode
  if (silent) return true;

  // set offset past spaces and ">"
  initial = offset = state.sCount[startLine] + 1;

  // skip one optional space after '>'
  if (src.charCodeAt(pos) === 0x20 /* space */) {
    // ' >   test '
    //     ^ -- position start of line here:
    pos++;
    initial++;
    offset++;
    adjustTab = false;
    spaceAfterMarker = true;
  } else if (src.charCodeAt(pos) === 0x09 /* tab */) {
    spaceAfterMarker = true;

    if ((state.bsCount[startLine] + offset) % 4 === 3) {
      // '  >\t  test '
      //       ^ -- position start of line here (tab has width===1)
      pos++;
      initial++;
      offset++;
      adjustTab = false;
    } else {
      // ' >\t  test '
      //    ^ -- position start of line here + shift bsCount slightly
      //         to make extra space appear
      adjustTab = true;
    }
  } else {
    adjustTab = false;
    spaceAfterMarker = false;
  }

  const oldBMarks = [state.bMarks[startLine]];
  state.bMarks[startLine] = pos;

  while (pos < max) {
    ch = src.charCodeAt(pos);

    if (isSpace(ch)) {
      if (ch === 0x09) {
        offset +=
          4 - ((offset + state.bsCount[startLine] + (adjustTab ? 1 : 0)) % 4);
      } else {
        offset++;
      }
    } else {
      break;
    }

    pos++;
  }

  const oldBSCount = [state.bsCount[startLine]];
  state.bsCount[startLine] =
    state.sCount[startLine] + 1 + (spaceAfterMarker ? 1 : 0);

  let lastLineEmpty = pos >= max;

  const oldSCount = [state.sCount[startLine]];
  state.sCount[startLine] = offset - initial;

  const oldTShift = [state.tShift[startLine]];
  state.tShift[startLine] = pos - state.bMarks[startLine];

  const terminators = state.blockquoteTerminators;

  const oldParentType = state.parentType;
  state.parentType = 'blockquote';

  // Search the end of the block
  //
  // Block ends with either:
  //  1. an empty line outside:
  //     ```
  //     > test
  //
  //     ```
  //  2. an empty line inside:
  //     ```
  //     >
  //     test
  //     ```
  //  3. another tag:
  //     ```
  //     > test
  //      - - -
  //     ```
  let nextLine: number;
  for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
    // check if it's outdented, i.e. it's inside list item and indented
    // less than said list item:
    //
    // ```
    // 1. anything
    //    > current blockquote
    // 2. checking this line
    // ```
    const isOutdented = state.sCount[nextLine] < state.blkIndent;

    pos = state.bMarks[nextLine] + state.tShift[nextLine];
    max = state.eMarks[nextLine];

    if (pos >= max) {
      // Case 1: line is not inside the blockquote, and this line is empty.
      break;
    }

    if (src.charCodeAt(pos++) === 0x3e /* > */ && !isOutdented) {
      // This line is inside the blockquote.

      // set offset past spaces and ">"
      initial = offset = state.sCount[nextLine] + 1;

      // skip one optional space after '>'
      if (src.charCodeAt(pos) === 0x20 /* space */) {
        // ' >   test '
        //     ^ -- position start of line here:
        pos++;
        initial++;
        offset++;
        adjustTab = false;
        spaceAfterMarker = true;
      } else if (src.charCodeAt(pos) === 0x09 /* tab */) {
        spaceAfterMarker = true;

        if ((state.bsCount[nextLine] + offset) % 4 === 3) {
          // '  >\t  test '
          //       ^ -- position start of line here (tab has width===1)
          pos++;
          initial++;
          offset++;
          adjustTab = false;
        } else {
          // ' >\t  test '
          //    ^ -- position start of line here + shift bsCount slightly
          //         to make extra space appear
          adjustTab = true;
        }
      } else {
        spaceAfterMarker = false;
      }

      oldBMarks.push(state.bMarks[nextLine]);
      state.bMarks[nextLine] = pos;

      while (pos < max) {
        ch = src.charCodeAt(pos);

        if (isSpace(ch)) {
          if (ch === 0x09) {
            offset +=
              4 -
              ((offset + state.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4);
          } else {
            offset++;
          }
        } else {
          break;
        }

        pos++;
      }

      lastLineEmpty = pos >= max;

      oldBSCount.push(state.bsCount[nextLine]);
      state.bsCount[nextLine] =
        state.sCount[nextLine] + 1 + (spaceAfterMarker ? 1 : 0);

      oldSCount.push(state.sCount[nextLine]);
      state.sCount[nextLine] = offset - initial;

      oldTShift.push(state.tShift[nextLine]);
      state.tShift[nextLine] = pos - state.bMarks[nextLine];
      continue;
    }

    // Case 2: line is not inside the blockquote, and the last line was empty.
    if (lastLineEmpty) break;

    // Case 3: another tag found.
    if (terminates(terminators, state, nextLine, endLine)) {
      // Quirk to enforce "hard termination mode" for paragraphs;
      // normally if you call `tokenize(state, startLine, nextLine)`,
      // paragraphs will look below nextLine for paragraph continuation,
      // but if blockquote is terminated by another tag, they shouldn't
      state.lineMax = nextLine;

      if (state.blkIndent !== 0) {
        // state.blkIndent was non-zero, we now set it to zero,
        // so we need to re-calculate all offsets to appear as
        // if indent wasn't changed
        oldBMarks.push(state.bMarks[nextLine]);
        oldBSCount.push(state.bsCount[nextLine]);
        oldTShift.push(state.tShift[nextLine]);
        oldSCount.push(state.sCount[nextLine]);
        state.sCount[nextLine] -= state.blkIndent;
      }

      break;
    }

    oldBMarks.push(state.bMarks[nextLine]);
    oldBSCount.push(state.bsCount[nextLine]);
    oldTShift.push(state.tShift[nextLine]);
    oldSCount.push(state.sCount[nextLine]);

    // A negative indentation means that this is a paragraph continuation
    //
    state.sCount[nextLine] = -1;
  }

  const oldIndent = state.blkIndent;
  state.blkIndent = 0;

  let token = state.push(T.BLOCKQUOTE_OPEN);
  token.markup = '>';
  token.map0 = startLine;
  token.map1 = 0;
  const open = token;

  state.tokenize(startLine, nextLine);

  token = state.push(T.BLOCKQUOTE_CLOSE);
  token.markup = '>';

  state.lineMax = oldLineMax;
  state.parentType = oldParentType;
  open.map1 = state.line;

  // Restore original tShift; this might not be necessary since the parser
  // has already been here, but just to make sure we can do that.
  for (let i = 0; i < oldTShift.length; i++) {
    state.bMarks[i + startLine] = oldBMarks[i];
    state.tShift[i + startLine] = oldTShift[i];
    state.sCount[i + startLine] = oldSCount[i];
    state.bsCount[i + startLine] = oldBSCount[i];
  }
  state.blkIndent = oldIndent;

  return true;
}

// ---------------------------------------------------------------- list

// Search `[-+*][\n ]`, returns next pos after marker on success
// or -1 on fail.
function skipBulletListMarker(state: BlockState, startLine: number) {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];

  const marker = state.src.charCodeAt(pos++);
  // Check bullet
  if (
    marker !== 0x2a /* * */ &&
    marker !== 0x2d /* - */ &&
    marker !== 0x2b /* + */
  )
    return -1;

  if (pos < max) {
    const ch = state.src.charCodeAt(pos);
    if (!isSpace(ch)) {
      // " -test " - is not a list item
      return -1;
    }
  }

  return pos;
}

// Search `\d+[.)][\n ]`, returns next pos after marker on success
// or -1 on fail.
function skipOrderedListMarker(state: BlockState, startLine: number) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  let pos = start;
  const max = state.eMarks[startLine];

  // List marker should have at least 2 chars (digit + dot)
  if (pos + 1 >= max) return -1;

  let ch = state.src.charCodeAt(pos++);

  if (ch < 0x30 /* 0 */ || ch > 0x39 /* 9 */) return -1;

  for (;;) {
    // EOL -> fail
    if (pos >= max) return -1;

    ch = state.src.charCodeAt(pos++);

    if (ch >= 0x30 /* 0 */ && ch <= 0x39 /* 9 */) {
      // List marker should have no more than 9 digits
      // (prevents integer overflow in browsers)
      if (pos - start >= 10) return -1;

      continue;
    }

    // found valid marker
    if (ch === 0x29 /* ) */ || ch === 0x2e /* . */) break;

    return -1;
  }

  if (pos < max) {
    ch = state.src.charCodeAt(pos);

    if (!isSpace(ch)) {
      // " 1.test " - is not a list item
      return -1;
    }
  }
  return pos;
}

function markTightParagraphs(state: BlockState, idx: number) {
  const level = state.level + 2;
  const pool = state.pool;

  for (let i = idx + 2, l = state.length - 2; i < l; i++) {
    if (pool[i].level === level && pool[i].type === T.PARAGRAPH_OPEN) {
      pool[i + 2].hidden = true;
      pool[i].hidden = true;
      i += 2;
    }
  }
}

function list(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  const allowIndentation = state.allowIndentation;
  let isTerminatingParagraph = false;
  let tight = true;
  let isOrdered: boolean;
  let posAfterMarker: number;
  let markerValue = 0;
  let start = 0;

  // if it's indented more than 3 spaces, it should be a code block
  if (indentedCode(state, startLine)) return false;

  // Special case:
  //  - item 1
  //   - item 2
  //    - item 3
  //     - item 4
  //      - this one is a paragraph continuation
  if (
    !allowIndentation &&
    state.listIndent >= 0 &&
    state.sCount[startLine] - state.listIndent >= 4 &&
    state.sCount[startLine] < state.blkIndent
  ) {
    return false;
  }

  // limit conditions when list can interrupt
  // a paragraph (validation mode only)
  if (silent && state.parentType === 'paragraph') {
    // Next list item should still terminate previous list item;
    //
    // This code can fail if plugins use blkIndent as well as lists,
    // but I hope the spec gets fixed long before that happens.
    //
    if (state.sCount[startLine] >= state.blkIndent) {
      isTerminatingParagraph = true;
    }
  }

  // Detect list type and position after marker
  if ((posAfterMarker = skipOrderedListMarker(state, startLine)) >= 0) {
    isOrdered = true;
    start = state.bMarks[startLine] + state.tShift[startLine];
    markerValue = Number(src.slice(start, posAfterMarker - 1));

    // If we're starting a new ordered list right after
    // a paragraph, it should start with 1.
    if (isTerminatingParagraph && markerValue !== 1) return false;
  } else if ((posAfterMarker = skipBulletListMarker(state, startLine)) >= 0) {
    isOrdered = false;
  } else {
    return false;
  }

  // If we're starting a new unordered list right after
  // a paragraph, first line should not be empty.
  if (isTerminatingParagraph) {
    if (state.skipSpaces(posAfterMarker) >= state.eMarks[startLine])
      return false;
  }

  // We should terminate list on style change. Remember first one to compare.
  const markerCharCode = src.charCodeAt(posAfterMarker - 1);
  const marker = String.fromCharCode(markerCharCode);

  // For validation mode we can terminate immediately
  if (silent) return true;

  // Start list
  const listTokIdx = state.length;

  let token: BlockToken;
  if (isOrdered) {
    token = state.push(T.ORDERED_LIST_OPEN);
    token.num = markerValue;
  } else {
    token = state.push(T.BULLET_LIST_OPEN);
  }
  const listOpen = token;
  listOpen.map0 = startLine;
  listOpen.map1 = 0;
  listOpen.markup = marker;

  //
  // Iterate list items
  //

  let nextLine = startLine;
  let prevEmptyEnd = false;
  const terminators = state.listTerminators;

  const oldParentType = state.parentType;
  state.parentType = 'list';

  while (nextLine < endLine) {
    let pos = posAfterMarker;
    const max = state.eMarks[nextLine];

    const initial =
      state.sCount[nextLine] +
      posAfterMarker -
      (state.bMarks[startLine] + state.tShift[startLine]);
    let offset = initial;

    while (pos < max) {
      const ch = src.charCodeAt(pos);

      if (ch === 0x09) {
        offset += 4 - ((offset + state.bsCount[nextLine]) % 4);
      } else if (ch === 0x20) {
        offset++;
      } else {
        break;
      }

      pos++;
    }

    const contentStart = pos;
    let indentAfterMarker: number;

    if (contentStart >= max) {
      // trimming space in "-    \n  3" case, indent is 1 here
      indentAfterMarker = 1;
    } else {
      indentAfterMarker = offset - initial;
    }

    // If we have more than 4 spaces, the indent is 1
    // (the rest is just indented code block)
    if (!allowIndentation && indentAfterMarker > 4) indentAfterMarker = 1;

    // "  -  test"
    //  ^^^^^ - calculating total length of this thing
    const indent = initial + indentAfterMarker;

    // Run subparser & write tokens
    token = state.push(T.LIST_ITEM_OPEN);
    token.markup = marker;
    token.map0 = startLine;
    token.map1 = 0;
    const itemOpen = token;

    // change current state, then restore it after parser subcall
    const oldTight = state.tight;
    const oldTShift = state.tShift[startLine];
    const oldSCount = state.sCount[startLine];

    //  - example list
    // ^ listIndent position will be here
    //   ^ blkIndent position will be here
    //
    const oldListIndent = state.listIndent;
    state.listIndent = state.blkIndent;
    state.blkIndent = indent;

    state.tight = true;
    state.tShift[startLine] = contentStart - state.bMarks[startLine];
    state.sCount[startLine] = offset;

    if (contentStart >= max && state.isEmpty(startLine + 1)) {
      // workaround for this case
      // (list item is empty, list terminates before "foo"):
      // ~~~~~~~~
      //   -
      //
      //     foo
      // ~~~~~~~~
      state.line = Math.min(state.line + 2, endLine);
    } else {
      state.tokenize(startLine, endLine);
    }

    // If any of list item is tight, mark list as tight
    if (!state.tight || prevEmptyEnd) tight = false;

    // Item become loose if finish with empty line,
    // but we should filter last element, because it means list finish
    prevEmptyEnd = state.line - startLine > 1 && state.isEmpty(state.line - 1);

    state.blkIndent = state.listIndent;
    state.listIndent = oldListIndent;
    state.tShift[startLine] = oldTShift;
    state.sCount[startLine] = oldSCount;
    state.tight = oldTight;

    token = state.push(T.LIST_ITEM_CLOSE);
    token.markup = marker;

    nextLine = startLine = state.line;
    itemOpen.map1 = nextLine;

    if (nextLine >= endLine) break;

    //
    // Try to check if list is terminated or continued.
    //
    if (state.sCount[nextLine] < state.blkIndent) break;

    // if it's indented more than 3 spaces, it should be a code block
    if (indentedCode(state, startLine)) break;

    // fail if terminating block found
    if (terminates(terminators, state, nextLine, endLine)) break;

    // fail if list has another type
    if (isOrdered) {
      posAfterMarker = skipOrderedListMarker(state, nextLine);
      if (posAfterMarker < 0) break;
      start = state.bMarks[nextLine] + state.tShift[nextLine];
    } else {
      posAfterMarker = skipBulletListMarker(state, nextLine);
      if (posAfterMarker < 0) break;
    }

    if (markerCharCode !== src.charCodeAt(posAfterMarker - 1)) break;
  }

  // Finalize list
  if (isOrdered) {
    token = state.push(T.ORDERED_LIST_CLOSE);
  } else {
    token = state.push(T.BULLET_LIST_CLOSE);
  }
  token.markup = marker;

  listOpen.map1 = nextLine;
  state.line = nextLine;

  state.parentType = oldParentType;

  // mark paragraphs tight if needed
  if (tight) markTightParagraphs(state, listTokIdx);

  return true;
}

// ---------------------------------------------------------------- reference

function reference(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  let lines = 0;
  const src = state.src;
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  let nextLine = startLine + 1;
  let ch: number;
  let labelEnd = -1;

  if (indentedCode(state, startLine)) return false;

  if (src.charCodeAt(pos) !== 0x5b /* [ */) return false;

  // Simple check to quickly interrupt scan on [link](url) at the start of line.
  // Can be useful on practice: https://github.com/markdown-it/markdown-it/issues/54
  while (++pos < max) {
    if (
      src.charCodeAt(pos) === 0x5d /* ] */ &&
      src.charCodeAt(pos - 1) !== 0x5c /* \ */
    ) {
      if (pos + 1 === max) return false;
      if (src.charCodeAt(pos + 1) !== 0x3a /* : */) return false;
      break;
    }
  }

  const endLine = state.lineMax;

  // jump line-by-line until empty one or EOF
  const terminators = state.referenceTerminators;

  const oldParentType = state.parentType;
  state.parentType = 'reference';

  for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
    // this would be a code block normally, but after paragraph
    // it's considered a lazy continuation regardless of what's there
    if (!state.allowIndentation && state.sCount[nextLine] - state.blkIndent > 3)
      continue;

    // quirk for blockquotes, this line should already be checked by that rule
    if (state.sCount[nextLine] < 0) continue;

    if (terminates(terminators, state, nextLine, endLine)) break;
  }

  const str = state
    .getLines(startLine, nextLine, state.blkIndent, false)
    .trim();
  max = str.length;

  for (pos = 1; pos < max; pos++) {
    ch = str.charCodeAt(pos);
    if (ch === 0x5b /* [ */) {
      return false;
    } else if (ch === 0x5d /* ] */) {
      labelEnd = pos;
      break;
    } else if (ch === 0x0a /* \n */) {
      lines++;
    } else if (ch === 0x5c /* \ */) {
      pos++;
      if (pos < max && str.charCodeAt(pos) === 0x0a) lines++;
    }
  }

  if (labelEnd < 0 || str.charCodeAt(labelEnd + 1) !== 0x3a /* : */)
    return false;

  // [label]:   destination   'title'
  //         ^^^ skip optional whitespace here
  for (pos = labelEnd + 2; pos < max; pos++) {
    ch = str.charCodeAt(pos);
    if (ch === 0x0a) {
      lines++;
    } else if (isSpace(ch)) {
      // spaces between parts are skipped
    } else {
      break;
    }
  }

  // [label]:   destination   'title'
  //            ^^^^^^^^^^^ parse this
  let res = md.helpers.parseLinkDestination(str, pos, max);
  if (!res.ok) return false;

  const href = md.normalizeLink(res.str);
  if (!md.validateLink(href)) return false;

  pos = res.pos;
  lines += res.lines;

  // save cursor state, we could require to rollback later
  const destEndPos = pos;
  const destEndLineNo = lines;

  // [label]:   destination   'title'
  //                       ^^^ skipping those spaces
  const start = pos;
  for (; pos < max; pos++) {
    ch = str.charCodeAt(pos);
    if (ch === 0x0a) {
      lines++;
    } else if (isSpace(ch)) {
      // spaces between parts are skipped
    } else {
      break;
    }
  }

  // [label]:   destination   'title'
  //                          ^^^^^^^ parse this
  res = md.helpers.parseLinkTitle(str, pos, max);
  let title: string;
  if (pos < max && start !== pos && res.ok) {
    title = res.str;
    pos = res.pos;
    lines += res.lines;
  } else {
    title = '';
    pos = destEndPos;
    lines = destEndLineNo;
  }

  // skip trailing spaces until the rest of the line
  while (pos < max) {
    ch = str.charCodeAt(pos);
    if (!isSpace(ch)) break;
    pos++;
  }

  if (pos < max && str.charCodeAt(pos) !== 0x0a) {
    if (title) {
      // garbage at the end of the line after title,
      // but it could still be a valid reference if we roll back
      title = '';
      pos = destEndPos;
      lines = destEndLineNo;
      while (pos < max) {
        ch = str.charCodeAt(pos);
        if (!isSpace(ch)) break;
        pos++;
      }
    }
  }

  if (pos < max && str.charCodeAt(pos) !== 0x0a) {
    // garbage at the end of the line
    return false;
  }

  const label = normalizeReference(str.slice(1, labelEnd));
  if (!label) {
    // CommonMark 0.20 disallows empty labels
    return false;
  }

  // Reference can not terminate anything. This check is for safety only.
  /*istanbul ignore if*/
  if (silent) return true;

  if (state.references === undefined) state.references = {};
  if (state.references[label] === undefined) {
    state.references[label] = { title, href };
  }

  state.parentType = oldParentType;

  state.line = startLine + lines + 1;
  return true;
}

// ---------------------------------------------------------------- html_block

// An array of opening and corresponding closing sequences for html tags,
// last argument defines whether it can terminate a paragraph or not
//
const HTML_SEQUENCES: [RegExp, RegExp, boolean][] = [
  [
    /^<(script|pre|style|textarea)(?=(\s|>|$))/i,
    /<\/(script|pre|style|textarea)>/i,
    true,
  ],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [
    new RegExp('^</?(' + htmlBlockNames.join('|') + ')(?=(\\s|/?>|$))', 'i'),
    /^$/,
    true,
  ],
  [new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + '\\s*$'), /^$/, false],
];

function htmlBlock(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];

  if (indentedCode(state, startLine)) return false;

  if (!state.html) return false;

  if (state.src.charCodeAt(pos) !== 0x3c /* < */) return false;

  let lineText = state.src.slice(pos, max);

  let i = 0;
  for (; i < HTML_SEQUENCES.length; i++) {
    if (HTML_SEQUENCES[i][0].test(lineText)) break;
  }

  if (i === HTML_SEQUENCES.length) return false;

  if (silent) {
    // true if this sequence can be a terminator, false otherwise
    return HTML_SEQUENCES[i][2];
  }

  let nextLine = startLine + 1;

  // If we are here - we detected HTML block.
  // Let's roll down till block end.
  if (!HTML_SEQUENCES[i][1].test(lineText)) {
    for (; nextLine < endLine; nextLine++) {
      if (state.sCount[nextLine] < state.blkIndent) break;

      pos = state.bMarks[nextLine] + state.tShift[nextLine];
      max = state.eMarks[nextLine];
      lineText = state.src.slice(pos, max);

      if (HTML_SEQUENCES[i][1].test(lineText)) {
        if (lineText.length !== 0) nextLine++;
        break;
      }
    }
  }

  state.line = nextLine;

  const token = state.push(T.HTML_BLOCK);
  token.map0 = startLine;
  token.map1 = nextLine;
  token.content = state.getLines(startLine, nextLine, state.blkIndent, true);

  return true;
}

// ---------------------------------------------------------------- table

function getLine(state: BlockState, line: number) {
  const pos = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  return max > pos ? state.src.slice(pos, max) : '';
}

function escapedSplit(str: string) {
  const result: string[] = [];
  const max = str.length;
  let pos = 0;
  let isEscaped = false;
  let lastPos = 0;
  let current = '';

  let ch = str.charCodeAt(pos);

  while (pos < max) {
    if (ch === 0x7c /* | */) {
      if (!isEscaped) {
        // pipe separating cells, '|'
        result.push(current + str.substring(lastPos, pos));
        current = '';
        lastPos = pos + 1;
      } else {
        // escaped pipe, '\|'
        current += str.substring(lastPos, pos - 1);
        lastPos = pos;
      }
    }

    isEscaped = ch === 0x5c /* \ */;
    pos++;

    ch = str.charCodeAt(pos);
  }

  result.push(current + str.substring(lastPos));

  return result;
}

const ALIGN_RE = /^:?-+:?$/;

function table(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  let ch: number;
  let i: number;

  // should have at least two lines
  if (startLine + 2 > endLine) return false;

  let nextLine = startLine + 1;

  if (state.sCount[nextLine] < state.blkIndent) return false;

  // if it's indented more than 3 spaces, it should be a code block
  if (indentedCode(state, nextLine)) return false;

  // first character of the second line should be '|', '-', ':',
  // and no other characters are allowed but spaces;
  // basically, this is the equivalent of /^[-:|][-:|\s]*$/ regexp

  let pos = state.bMarks[nextLine] + state.tShift[nextLine];
  if (pos >= state.eMarks[nextLine]) return false;

  const firstCh = src.charCodeAt(pos++);
  if (
    firstCh !== 0x7c /* | */ &&
    firstCh !== 0x2d /* - */ &&
    firstCh !== 0x3a /* : */
  )
    return false;

  if (pos >= state.eMarks[nextLine]) return false;

  const secondCh = src.charCodeAt(pos++);
  if (
    secondCh !== 0x7c /* | */ &&
    secondCh !== 0x2d /* - */ &&
    secondCh !== 0x3a /* : */ &&
    !isSpace(secondCh)
  ) {
    return false;
  }

  // if first character is '-', then second character must not be a space
  // (due to parsing ambiguity with list)
  if (firstCh === 0x2d /* - */ && isSpace(secondCh)) return false;

  while (pos < state.eMarks[nextLine]) {
    ch = src.charCodeAt(pos);

    if (
      ch !== 0x7c /* | */ &&
      ch !== 0x2d /* - */ &&
      ch !== 0x3a /* : */ &&
      !isSpace(ch)
    )
      return false;

    pos++;
  }

  let lineText = getLine(state, startLine + 1);

  let columns = lineText.split('|');
  const aligns: string[] = [];
  for (i = 0; i < columns.length; i++) {
    const t = columns[i].trim();
    if (!t) {
      // allow empty columns before and after table, but not in between columns;
      // e.g. allow ` |---| `, disallow ` ---||--- `
      if (i === 0 || i === columns.length - 1) {
        continue;
      } else {
        return false;
      }
    }

    if (!ALIGN_RE.test(t)) return false;
    if (t.charCodeAt(t.length - 1) === 0x3a /* : */) {
      aligns.push(t.charCodeAt(0) === 0x3a /* : */ ? 'center' : 'right');
    } else if (t.charCodeAt(0) === 0x3a /* : */) {
      aligns.push('left');
    } else {
      aligns.push('');
    }
  }

  lineText = getLine(state, startLine).trim();
  if (lineText.indexOf('|') === -1) return false;
  if (indentedCode(state, startLine)) return false;
  columns = escapedSplit(lineText);
  if (columns.length && columns[0] === '') columns.shift();
  if (columns.length && columns[columns.length - 1] === '') columns.pop();

  // header row will define an amount of columns in the entire table,
  // and align row should be exactly the same (the rest of the rows can differ)
  const columnCount = columns.length;
  if (columnCount === 0 || columnCount !== aligns.length) return false;

  if (silent) return true;

  const oldParentType = state.parentType;
  state.parentType = 'table';

  // use 'blockquote' lists for termination because it's
  // the most similar to tables
  const terminators = state.blockquoteTerminators;

  let token = state.push(T.TABLE_OPEN);
  token.map0 = startLine;
  token.map1 = 0;
  const tableOpen = token;

  token = state.push(T.THEAD_OPEN);
  token.map0 = startLine;
  token.map1 = startLine + 1;

  token = state.push(T.TR_OPEN);
  token.map0 = startLine;
  token.map1 = startLine + 1;

  for (i = 0; i < columns.length; i++) {
    token = state.push(T.TH_OPEN);
    token.str = aligns[i];

    token = state.push(T.INLINE);
    token.content = columns[i].trim();

    state.push(T.TH_CLOSE);
  }

  state.push(T.TR_CLOSE);
  state.push(T.THEAD_CLOSE);

  let tbodyOpen: BlockToken | undefined;
  for (nextLine = startLine + 2; nextLine < endLine; nextLine++) {
    if (state.sCount[nextLine] < state.blkIndent) break;

    if (terminates(terminators, state, nextLine, endLine)) break;

    lineText = getLine(state, nextLine).trim();
    if (!lineText) break;
    if (indentedCode(state, nextLine)) break;
    columns = escapedSplit(lineText);
    if (columns.length && columns[0] === '') columns.shift();
    if (columns.length && columns[columns.length - 1] === '') columns.pop();

    if (nextLine === startLine + 2) {
      token = state.push(T.TBODY_OPEN);
      token.map0 = startLine + 2;
      token.map1 = 0;
      tbodyOpen = token;
    }

    token = state.push(T.TR_OPEN);
    token.map0 = nextLine;
    token.map1 = nextLine + 1;

    for (i = 0; i < columnCount; i++) {
      token = state.push(T.TD_OPEN);
      token.str = aligns[i];

      token = state.push(T.INLINE);
      token.content = columns[i] ? columns[i].trim() : '';

      state.push(T.TD_CLOSE);
    }
    state.push(T.TR_CLOSE);
  }

  if (tbodyOpen) {
    state.push(T.TBODY_CLOSE);
    tbodyOpen.map1 = nextLine;
  }

  state.push(T.TABLE_CLOSE);
  tableOpen.map1 = nextLine;

  state.parentType = oldParentType;
  state.line = nextLine;
  return true;
}

// ---------------------------------------------------------------- Markdoc tags

/** Markdoc's `createToken`: parses a tag's content with the tag grammar. */
export function pushTag(
  push: (type: number) => { meta: any; info?: string },
  content: string,
  contentStart?: number
) {
  try {
    const { type, meta } = parseTag(content, { Variable, Function });
    const token = push(grammarKind(type));
    token.info = content;
    token.meta = meta;
    return token;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    const {
      message,
      location: { start, end },
    } = error as any;
    const location = contentStart
      ? {
          start: { offset: start.offset + contentStart },
          end: { offset: end.offset + contentStart },
        }
      : null;

    const token = push(T.ERROR);
    token.meta = { error: { message, location } };
    return token;
  }
}

function tag(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  const src = state.src;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const finish = state.eMarks[startLine];

  if (
    src.charCodeAt(start) !== 0x7b /* { */ ||
    src.charCodeAt(start + 1) !== 0x25 /* % */
  )
    return false;

  const tagEnd = findTagEnd(src, start);

  // Markdoc computes `src.slice(0, finish).trim().length`; this is the same
  // number without copying the document prefix on every call. (`trim` also
  // drops the document's leading whitespace, so it is subtracted.)
  let last = finish;
  while (last > 0 && isTrimmable(src.charCodeAt(last - 1))) last--;
  const lastPossible =
    last > state.firstNonSpace ? last - state.firstNonSpace : 0;

  if (!tagEnd || tagEnd < lastPossible - CLOSE.length) return false;

  const contentStart = start + OPEN.length;
  let lines = 1;
  for (let i = start; i < tagEnd + CLOSE.length; i++)
    if (src.charCodeAt(i) === 0x0a) lines++;
  const text = state.getLines(startLine, startLine + lines, 0, false);
  const content = text
    .slice(text.indexOf(OPEN) + OPEN.length, findTagEnd(text) as number)
    .trim();

  if (content[0] === '$') return false;

  if (silent) return true;

  const token = pushTag((type) => state.push(type), content, contentStart);
  (token as BlockToken).map0 = startLine;
  (token as BlockToken).map1 = startLine + lines;
  state.line += lines;
  return true;
}

// ---------------------------------------------------------------- comments

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

function comment(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (!state.src.startsWith(COMMENT_OPEN, start)) return false;

  const close = state.src.indexOf(COMMENT_CLOSE, start);

  if (close === -1) return false;
  if (silent) return true;

  const content = state.src.slice(start + COMMENT_OPEN.length, close);
  let lines = 1;
  for (let i = 0; i < content.length; i++)
    if (content.charCodeAt(i) === 0x0a) lines++;
  const token = state.push(T.COMMENT);
  token.content = content.trim();
  token.map0 = startLine;
  token.map1 = startLine + lines;
  state.line += lines;

  return true;
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER_FENCE = '---';

function frontmatterLine(state: BlockState, n: number) {
  return state.src.slice(state.bMarks[n], state.eMarks[n]).trim();
}

function frontmatter(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  if (startLine != 0 || frontmatterLine(state, 0) != FRONTMATTER_FENCE)
    return false;

  let close = 0;
  for (let line = 1; line < endLine; line++)
    if (frontmatterLine(state, line) === FRONTMATTER_FENCE) {
      close = line;
      break;
    }

  if (!close) return false;
  if (silent) return true;

  const token = state.push(T.FRONTMATTER);
  token.content = state.src.slice(state.eMarks[0], state.bMarks[close]).trim();
  token.map0 = 0;
  token.map1 = close;
  token.hidden = true;

  state.line = close + 1;
  return true;
}
