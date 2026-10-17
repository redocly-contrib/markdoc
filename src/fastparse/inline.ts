/**
 * Inline parsing: a port of markdown-it 12.3.2's inline rules and
 * post-processing, plus Markdoc's inline tag and comment rules, producing the
 * same token sequence.
 *
 * Differences from markdown-it are again only in the machinery: tokens are
 * pooled, rules are dispatched on the first character instead of being tried
 * in turn, and anchored regexes run sticky against the source instead of
 * against a fresh `src.slice(pos)` copy.
 */
import { HTML_TAG_RE } from 'markdown-it/lib/common/html_re';
import entities from 'markdown-it/lib/common/entities';
import { findTagEnd, OPEN, CLOSE } from '../utils';
import { md, pushTag } from './block';
import * as T from './tokens';
import { InlineToken, Delimiter, NESTING } from './tokens';

const {
  normalizeReference,
  isWhiteSpace,
  isPunctChar,
  isMdAsciiPunct,
  isValidEntityCode,
  fromCodePoint,
} = md.utils;

const MAX_NESTING = 100;

function isSpace(code: number) {
  return code === 0x09 || code === 0x20;
}

// markdown-it's `text` rule stops at these characters.
const TERMINATOR = new Uint8Array(128);
for (const ch of '\n!#$%&*+-:<=>@[\\]^_`{}~') TERMINATOR[ch.charCodeAt(0)] = 1;

const ESCAPED = new Uint8Array(256);
for (const ch of '\\!"#$%&\'()*+,./:;<=>?@[]^_`{|}~-')
  ESCAPED[ch.charCodeAt(0)] = 1;

export type InlineOptions = {
  html: boolean;
  allowComments: boolean;
};

export class InlineState {
  src = '';
  pos = 0;
  posMax = 0;
  level = 0;
  pending = '';
  pendingLevel = 0;
  cache = new Map<number, number>();
  delimiters: Delimiter[] = [];
  prevDelimiters: Delimiter[][] = [];
  /** The `delimiters` of each opening token, in push order (`tokens_meta`). */
  scopes: Delimiter[][] = [];
  backticks: Record<number, number> = {};
  backticksScanned = false;

  pool: InlineToken[] = [];
  length = 0;

  references: Record<string, { title: string; href: string }> | undefined;
  html: boolean;
  allowComments: boolean;

  constructor(options: InlineOptions) {
    this.html = options.html;
    this.allowComments = options.allowComments;
  }

  private alloc(type: number): InlineToken {
    let token = this.pool[this.length];
    if (token === undefined) {
      token = new InlineToken();
      this.pool.push(token);
    } else {
      token.content = '';
      token.info = '';
      token.markup = '';
      token.href = '';
      token.title = '';
      token.meta = null;
      token.delimiters = null;
    }
    token.type = type;
    this.length++;
    return token;
  }

  pushPending(): InlineToken {
    const token = this.alloc(T.TEXT);
    token.content = this.pending;
    token.level = this.pendingLevel;
    this.pending = '';
    return token;
  }

  push(type: number): InlineToken {
    if (this.pending) this.pushPending();

    const token = this.alloc(type);
    const nesting = NESTING[type];

    if (nesting < 0) {
      // closing tag
      this.level--;
      this.delimiters = this.prevDelimiters.pop() as Delimiter[];
    }

    token.level = this.level;

    if (nesting > 0) {
      // opening tag
      this.level++;
      this.prevDelimiters.push(this.delimiters);
      this.delimiters = [];
      token.delimiters = this.delimiters;
      this.scopes.push(this.delimiters);
    }

    this.pendingLevel = this.level;
    return token;
  }

  /**
   * Scan a sequence of emphasis-like markers, and determine whether
   * it can start an emphasis sequence or end an emphasis sequence.
   */
  scanDelims(start: number, canSplitWord: boolean) {
    const max = this.posMax;
    const src = this.src;
    const marker = src.charCodeAt(start);
    let pos = start;
    let leftFlanking = true;
    let rightFlanking = true;

    // treat beginning of the line as a whitespace
    const lastChar = start > 0 ? src.charCodeAt(start - 1) : 0x20;

    while (pos < max && src.charCodeAt(pos) === marker) pos++;

    const count = pos - start;

    // treat end of the line as a whitespace
    const nextChar = pos < max ? src.charCodeAt(pos) : 0x20;

    const isLastPunctChar = isPunctuation(lastChar);
    const isNextPunctChar = isPunctuation(nextChar);

    const isLastWhiteSpace = isWhiteSpace(lastChar);
    const isNextWhiteSpace = isWhiteSpace(nextChar);

    if (isNextWhiteSpace) {
      leftFlanking = false;
    } else if (isNextPunctChar) {
      if (!(isLastWhiteSpace || isLastPunctChar)) leftFlanking = false;
    }

    if (isLastWhiteSpace) {
      rightFlanking = false;
    } else if (isLastPunctChar) {
      if (!(isNextWhiteSpace || isNextPunctChar)) rightFlanking = false;
    }

    let canOpen: boolean;
    let canClose: boolean;
    if (!canSplitWord) {
      canOpen = leftFlanking && (!rightFlanking || isLastPunctChar);
      canClose = rightFlanking && (!leftFlanking || isNextPunctChar);
    } else {
      canOpen = leftFlanking;
      canClose = rightFlanking;
    }

    return { canOpen, canClose, length: count };
  }

  /** markdown-it's `ParserInline#tokenize`. */
  tokenize() {
    const end = this.posMax;

    while (this.pos < end) {
      // Try all possible rules.
      // On success, rule should:
      //
      // - update `state.pos`
      // - update `state.tokens`
      // - return true
      let ok = false;
      if (this.level < MAX_NESTING) ok = rule(this, false);

      if (ok) {
        if (this.pos >= end) break;
        continue;
      }

      this.pending += this.src[this.pos++];
    }

    if (this.pending) this.pushPending();
  }

  /**
   * Skip single token by running all rules in validation mode;
   * returns `true` if any rule reported success.
   */
  skipToken() {
    const pos = this.pos;
    const cached = this.cache.get(pos);

    if (cached !== undefined) {
      this.pos = cached;
      return;
    }

    let ok = false;
    if (this.level < MAX_NESTING) {
      this.level++;
      ok = rule(this, true);
      this.level--;
    } else {
      // Too much nesting, just skip until the end of the paragraph.
      this.pos = this.posMax;
    }

    if (!ok) this.pos++;
    this.cache.set(pos, this.pos);
  }

  /** markdown-it's `ParserInline#parse`: tokenize `src`, then post-process. */
  parse(src: string, references: InlineState['references']) {
    this.src = src;
    this.pos = 0;
    this.posMax = src.length;
    this.level = 0;
    this.pending = '';
    this.pendingLevel = 0;
    this.cache.clear();
    this.delimiters = [];
    this.prevDelimiters.length = 0;
    this.scopes.length = 0;
    this.backticks = {};
    this.backticksScanned = false;
    this.length = 0;
    this.references = references;

    this.tokenize();

    balancePairs(this);
    strikethroughPostProcess(this);
    emphasisPostProcess(this);
    textCollapse(this);
  }
}

function isPunctuation(code: number) {
  // For ASCII, Unicode punctuation is a subset of markdown's ASCII punctuation.
  return code < 0x80
    ? isMdAsciiPunct(code)
    : isPunctChar(String.fromCharCode(code));
}

/** The inline rules in markdown-it's order, dispatched on the character. */
function rule(state: InlineState, silent: boolean): boolean {
  const ch = state.src.charCodeAt(state.pos);
  if (ch >= 0x80 || !TERMINATOR[ch]) return text(state, silent);
  switch (ch) {
    case 0x0a /* \n */:
      return newline(state, silent);
    case 0x5c /* \ */:
      return escape(state, silent);
    case 0x60 /* ` */:
      return backticks(state, silent);
    case 0x7e /* ~ */:
      return strikethrough(state, silent);
    case 0x2a /* * */:
    case 0x5f /* _ */:
      return emphasis(state, silent);
    case 0x5b /* [ */:
      return link(state, silent);
    case 0x21 /* ! */:
      return image(state, silent);
    case 0x3c /* < */:
      return (
        autolink(state, silent) ||
        htmlInline(state, silent) ||
        (state.allowComments && comment(state, silent))
      );
    case 0x26 /* & */:
      return entity(state, silent);
    case 0x7b /* { */:
      return tag(state, silent);
    default:
      return false;
  }
}

// ---------------------------------------------------------------- text

function text(state: InlineState, silent: boolean): boolean {
  const src = state.src;
  const max = state.posMax;
  let pos = state.pos;

  while (pos < max) {
    const ch = src.charCodeAt(pos);
    if (ch < 0x80 && TERMINATOR[ch]) break;
    pos++;
  }

  if (pos === state.pos) return false;

  if (!silent) state.pending += src.slice(state.pos, pos);

  state.pos = pos;

  return true;
}

// ---------------------------------------------------------------- newline

function newline(state: InlineState, silent: boolean): boolean {
  let pos = state.pos;

  const pmax = state.pending.length - 1;
  const max = state.posMax;

  // '  \n' -> hardbreak
  // Lookup in pending chars is bad practice! Don't copy to other rules!
  // Pending string is stored in concat mode, indexed lookups will cause
  // convertion to flat mode.
  if (!silent) {
    if (pmax >= 0 && state.pending.charCodeAt(pmax) === 0x20) {
      if (pmax >= 1 && state.pending.charCodeAt(pmax - 1) === 0x20) {
        // Find whitespaces tail of pending chars.
        let ws = pmax - 1;
        while (ws >= 1 && state.pending.charCodeAt(ws - 1) === 0x20) ws--;

        state.pending = state.pending.slice(0, ws);
        state.push(T.HARDBREAK);
      } else {
        state.pending = state.pending.slice(0, -1);
        state.push(T.SOFTBREAK);
      }
    } else {
      state.push(T.SOFTBREAK);
    }
  }

  pos++;

  // skip heading spaces for next line
  while (pos < max && isSpace(state.src.charCodeAt(pos))) pos++;

  state.pos = pos;
  return true;
}

// ---------------------------------------------------------------- escape

function escape(state: InlineState, silent: boolean): boolean {
  let pos = state.pos;
  const max = state.posMax;

  pos++;

  if (pos < max) {
    let ch = state.src.charCodeAt(pos);

    if (ch < 256 && ESCAPED[ch] !== 0) {
      if (!silent) state.pending += state.src[pos];
      state.pos += 2;
      return true;
    }

    if (ch === 0x0a) {
      if (!silent) state.push(T.HARDBREAK);

      pos++;
      // skip leading whitespaces from next line
      while (pos < max) {
        ch = state.src.charCodeAt(pos);
        if (!isSpace(ch)) break;
        pos++;
      }

      state.pos = pos;
      return true;
    }
  }

  if (!silent) state.pending += '\\';
  state.pos++;
  return true;
}

// ---------------------------------------------------------------- backticks

const CODE_SPAN_PADDING_RE = /^ (.+) $/;

function backticks(state: InlineState, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;

  const start = pos;
  pos++;
  const max = state.posMax;

  // scan marker length
  while (pos < max && src.charCodeAt(pos) === 0x60 /* ` */) pos++;

  const marker = src.slice(start, pos);
  const openerLength = marker.length;

  if (state.backticksScanned && (state.backticks[openerLength] || 0) <= start) {
    if (!silent) state.pending += marker;
    state.pos += openerLength;
    return true;
  }

  let matchStart: number;
  let matchEnd = pos;

  // Nothing found in the cache, scan until the end of the line (or until marker is found)
  while ((matchStart = src.indexOf('`', matchEnd)) !== -1) {
    matchEnd = matchStart + 1;

    // scan marker length
    while (matchEnd < max && src.charCodeAt(matchEnd) === 0x60 /* ` */)
      matchEnd++;

    const closerLength = matchEnd - matchStart;

    if (closerLength === openerLength) {
      // Found matching closer length.
      if (!silent) {
        const token = state.push(T.CODE_INLINE);
        token.markup = marker;
        let content = src.slice(pos, matchStart);
        if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
        if (
          content.length > 2 &&
          content.charCodeAt(0) === 0x20 &&
          content.charCodeAt(content.length - 1) === 0x20
        )
          content = content.replace(CODE_SPAN_PADDING_RE, '$1');
        token.content = content;
      }
      state.pos = matchEnd;
      return true;
    }

    // Some different length found, put it in cache as upper limit of where closer can be found
    state.backticks[closerLength] = matchStart;
  }

  // Scanned through the end, didn't find anything
  state.backticksScanned = true;

  if (!silent) state.pending += marker;
  state.pos += openerLength;
  return true;
}

// ---------------------------------------------------------------- strikethrough

function strikethrough(state: InlineState, silent: boolean): boolean {
  const marker = state.src.charCodeAt(state.pos);

  if (silent) return false;

  const scanned = state.scanDelims(state.pos, true);
  let len = scanned.length;
  const ch = String.fromCharCode(marker);

  if (len < 2) return false;

  if (len % 2) {
    const token = state.push(T.TEXT);
    token.content = ch;
    len--;
  }

  for (let i = 0; i < len; i += 2) {
    const token = state.push(T.TEXT);
    token.content = ch + ch;

    state.delimiters.push({
      marker,
      length: 0, // disable "rule of 3" length checks meant for emphasis
      token: state.length - 1,
      end: -1,
      open: scanned.canOpen,
      close: scanned.canClose,
    });
  }

  state.pos += scanned.length;

  return true;
}

function strikethroughProcess(state: InlineState, delimiters: Delimiter[]) {
  const loneMarkers: number[] = [];
  const max = delimiters.length;
  const tokens = state.pool;

  for (let i = 0; i < max; i++) {
    const startDelim = delimiters[i];

    if (startDelim.marker !== 0x7e /* ~ */) continue;

    if (startDelim.end === -1) continue;

    const endDelim = delimiters[startDelim.end];

    let token = tokens[startDelim.token];
    token.type = T.S_OPEN;
    token.markup = '~~';
    token.content = '';

    token = tokens[endDelim.token];
    token.type = T.S_CLOSE;
    token.markup = '~~';
    token.content = '';

    if (
      tokens[endDelim.token - 1].type === T.TEXT &&
      tokens[endDelim.token - 1].content === '~'
    ) {
      loneMarkers.push(endDelim.token - 1);
    }
  }

  // If a marker sequence has an odd number of characters, it's splitted
  // like this: `~~~~~` -> `~` + `~~` + `~~`, leaving one marker at the
  // start of the sequence.
  //
  // So, we have to move all those markers after subsequent s_close tags.
  //
  while (loneMarkers.length) {
    const i = loneMarkers.pop() as number;
    let j = i + 1;

    while (j < state.length && tokens[j].type === T.S_CLOSE) j++;

    j--;

    if (i !== j) {
      const token = tokens[j];
      tokens[j] = tokens[i];
      tokens[i] = token;
    }
  }
}

function strikethroughPostProcess(state: InlineState) {
  strikethroughProcess(state, state.delimiters);
  for (const scope of state.scopes) strikethroughProcess(state, scope);
}

// ---------------------------------------------------------------- emphasis

function emphasis(state: InlineState, silent: boolean): boolean {
  const marker = state.src.charCodeAt(state.pos);

  if (silent) return false;

  const scanned = state.scanDelims(state.pos, marker === 0x2a);

  for (let i = 0; i < scanned.length; i++) {
    const token = state.push(T.TEXT);
    token.content = String.fromCharCode(marker);

    state.delimiters.push({
      // Char code of the starting marker (number).
      marker,
      // Total length of these series of delimiters.
      length: scanned.length,
      // A position of the token this delimiter corresponds to.
      token: state.length - 1,
      // If this delimiter is matched as a valid opener, `end` will be
      // equal to its position, otherwise it's `-1`.
      end: -1,
      // Boolean flags that determine if this delimiter could open or close
      // an emphasis.
      open: scanned.canOpen,
      close: scanned.canClose,
    });
  }

  state.pos += scanned.length;

  return true;
}

function emphasisProcess(state: InlineState, delimiters: Delimiter[]) {
  const max = delimiters.length;
  const tokens = state.pool;

  for (let i = max - 1; i >= 0; i--) {
    const startDelim = delimiters[i];

    if (
      startDelim.marker !== 0x5f /* _ */ &&
      startDelim.marker !== 0x2a /* * */
    )
      continue;

    // Process only opening markers
    if (startDelim.end === -1) continue;

    const endDelim = delimiters[startDelim.end];

    // If the previous delimiter has the same marker and is adjacent to this one,
    // merge those into one strong delimiter.
    //
    // `<em><em>whatever</em></em>` -> `<strong>whatever</strong>`
    //
    const isStrong =
      i > 0 &&
      delimiters[i - 1].end === startDelim.end + 1 &&
      delimiters[i - 1].marker === startDelim.marker &&
      delimiters[i - 1].token === startDelim.token - 1 &&
      delimiters[startDelim.end + 1].token === endDelim.token + 1;

    const ch = String.fromCharCode(startDelim.marker);

    let token = tokens[startDelim.token];
    token.type = isStrong ? T.STRONG_OPEN : T.EM_OPEN;
    token.markup = isStrong ? ch + ch : ch;
    token.content = '';

    token = tokens[endDelim.token];
    token.type = isStrong ? T.STRONG_CLOSE : T.EM_CLOSE;
    token.markup = isStrong ? ch + ch : ch;
    token.content = '';

    if (isStrong) {
      tokens[delimiters[i - 1].token].content = '';
      tokens[delimiters[startDelim.end + 1].token].content = '';
      i--;
    }
  }
}

function emphasisPostProcess(state: InlineState) {
  emphasisProcess(state, state.delimiters);
  for (const scope of state.scopes) emphasisProcess(state, scope);
}

// ---------------------------------------------------------------- balance_pairs

function processDelimiters(delimiters: Delimiter[]) {
  const openersBottom: Record<number, number[]> = {};
  const max = delimiters.length;

  if (!max) return;

  // headerIdx is the first delimiter of the current (where closer is) delimiter run
  let headerIdx = 0;
  let lastTokenIdx = -2; // needs any value lower than -1
  const jumps: number[] = [];

  for (let closerIdx = 0; closerIdx < max; closerIdx++) {
    const closer = delimiters[closerIdx];

    jumps.push(0);

    // markers belong to same delimiter run if:
    //  - they have adjacent tokens
    //  - AND markers are the same
    //
    if (
      delimiters[headerIdx].marker !== closer.marker ||
      lastTokenIdx !== closer.token - 1
    ) {
      headerIdx = closerIdx;
    }

    lastTokenIdx = closer.token;

    // Length is only used for emphasis-specific "rule of 3",
    // if it's not defined (in strikethrough or 3rd party plugins),
    // we can default it to 0 to disable those checks.
    //
    closer.length = closer.length || 0;

    if (!closer.close) continue;

    // Previously calculated lower bounds (previous fails)
    // for each marker, each delimiter length modulo 3,
    // and for whether this closer can be an opener;
    // https://github.com/commonmark/cmark/commit/34250e12ccebdc6372b8b49c44fab57c72443460
    if (!Object.prototype.hasOwnProperty.call(openersBottom, closer.marker)) {
      openersBottom[closer.marker] = [-1, -1, -1, -1, -1, -1];
    }

    const minOpenerIdx =
      openersBottom[closer.marker][(closer.open ? 3 : 0) + (closer.length % 3)];

    let openerIdx = headerIdx - jumps[headerIdx] - 1;

    let newMinOpenerIdx = openerIdx;

    for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx] + 1) {
      const opener = delimiters[openerIdx];

      if (opener.marker !== closer.marker) continue;

      if (opener.open && opener.end < 0) {
        let isOddMatch = false;

        // from spec:
        //
        // If one of the delimiters can both open and close emphasis, then the
        // sum of the lengths of the delimiter runs containing the opening and
        // closing delimiters must not be a multiple of 3 unless both lengths
        // are multiples of 3.
        //
        if (opener.close || closer.open) {
          if ((opener.length + closer.length) % 3 === 0) {
            if (opener.length % 3 !== 0 || closer.length % 3 !== 0) {
              isOddMatch = true;
            }
          }
        }

        if (!isOddMatch) {
          // If previous delimiter cannot be an opener, we can safely skip
          // the entire sequence in future checks. This is required to make
          // sure algorithm has linear complexity (see *_*_*_*_*_... case).
          //
          const lastJump =
            openerIdx > 0 && !delimiters[openerIdx - 1].open
              ? jumps[openerIdx - 1] + 1
              : 0;

          jumps[closerIdx] = closerIdx - openerIdx + lastJump;
          jumps[openerIdx] = lastJump;

          closer.open = false;
          opener.end = closerIdx;
          opener.close = false;
          newMinOpenerIdx = -1;
          // treat next token as start of run,
          // it optimizes skips in **<...>**a**<...>** pathological case
          lastTokenIdx = -2;
          break;
        }
      }
    }

    if (newMinOpenerIdx !== -1) {
      // If match for this delimiter run failed, we want to set lower bound for
      // future lookups. This is required to make sure algorithm has linear
      // complexity.
      //
      // See details here:
      // https://github.com/commonmark/cmark/issues/178#issuecomment-270417442
      //
      openersBottom[closer.marker][
        (closer.open ? 3 : 0) + ((closer.length || 0) % 3)
      ] = newMinOpenerIdx;
    }
  }
}

function balancePairs(state: InlineState) {
  processDelimiters(state.delimiters);
  for (const scope of state.scopes) processDelimiters(scope);
}

// ---------------------------------------------------------------- text_collapse

/** Merges adjacent text tokens, keeping every pooled token in the pool. */
function textCollapse(state: InlineState) {
  const tokens = state.pool;
  const max = state.length;
  let last = 0;
  let curr = 0;

  for (; curr < max; curr++) {
    if (
      tokens[curr].type === T.TEXT &&
      curr + 1 < max &&
      tokens[curr + 1].type === T.TEXT
    ) {
      // collapse two adjacent text nodes
      tokens[curr + 1].content =
        tokens[curr].content + tokens[curr + 1].content;
    } else {
      if (curr !== last) {
        const token = tokens[last];
        tokens[last] = tokens[curr];
        tokens[curr] = token;
      }

      last++;
    }
  }

  state.length = last;
}

// ---------------------------------------------------------------- links

function parseLinkLabel(
  state: InlineState,
  start: number,
  disableNested?: boolean
): number {
  let found = false;
  let labelEnd = -1;
  const max = state.posMax;
  const oldPos = state.pos;

  state.pos = start + 1;
  let level = 1;

  while (state.pos < max) {
    const marker = state.src.charCodeAt(state.pos);
    if (marker === 0x5d /* ] */) {
      level--;
      if (level === 0) {
        found = true;
        break;
      }
    }

    const prevPos = state.pos;
    state.skipToken();
    if (marker === 0x5b /* [ */) {
      if (prevPos === state.pos - 1) {
        // increase level if we find text `[`, which is not a part of any token
        level++;
      } else if (disableNested) {
        state.pos = oldPos;
        return -1;
      }
    }
  }

  if (found) labelEnd = state.pos;

  // restore old state
  state.pos = oldPos;

  return labelEnd;
}

function link(state: InlineState, silent: boolean): boolean {
  let href = '';
  let title = '';
  const oldPos = state.pos;
  const max = state.posMax;
  let start = state.pos;
  let parseReference = true;
  let label: string | undefined;
  let code: number;

  const labelStart = state.pos + 1;
  const labelEnd = parseLinkLabel(state, state.pos, true);

  // parser failed to find ']', so it's not a valid link
  if (labelEnd < 0) return false;

  let pos = labelEnd + 1;
  if (pos < max && state.src.charCodeAt(pos) === 0x28 /* ( */) {
    //
    // Inline link
    //

    // might have found a valid shortcut link, disable reference parsing
    parseReference = false;

    // [link](  <href>  "title"  )
    //        ^^ skipping these spaces
    pos++;
    for (; pos < max; pos++) {
      code = state.src.charCodeAt(pos);
      if (!isSpace(code) && code !== 0x0a) break;
    }
    if (pos >= max) return false;

    // [link](  <href>  "title"  )
    //          ^^^^^^ parsing link destination
    start = pos;
    let res = md.helpers.parseLinkDestination(state.src, pos, state.posMax);
    if (res.ok) {
      href = md.normalizeLink(res.str);
      if (md.validateLink(href)) {
        pos = res.pos;
      } else {
        href = '';
      }

      // [link](  <href>  "title"  )
      //                ^^ skipping these spaces
      start = pos;
      for (; pos < max; pos++) {
        code = state.src.charCodeAt(pos);
        if (!isSpace(code) && code !== 0x0a) break;
      }

      // [link](  <href>  "title"  )
      //                  ^^^^^^^ parsing link title
      res = md.helpers.parseLinkTitle(state.src, pos, state.posMax);
      if (pos < max && start !== pos && res.ok) {
        title = res.str;
        pos = res.pos;

        // [link](  <href>  "title"  )
        //                         ^^ skipping these spaces
        for (; pos < max; pos++) {
          code = state.src.charCodeAt(pos);
          if (!isSpace(code) && code !== 0x0a) break;
        }
      }
    }

    if (pos >= max || state.src.charCodeAt(pos) !== 0x29 /* ) */) {
      // parsing a valid shortcut link failed, fallback to reference
      parseReference = true;
    }
    pos++;
  }

  if (parseReference) {
    //
    // Link reference
    //
    if (state.references === undefined) return false;

    if (pos < max && state.src.charCodeAt(pos) === 0x5b /* [ */) {
      start = pos + 1;
      pos = parseLinkLabel(state, pos);
      if (pos >= 0) {
        label = state.src.slice(start, pos++);
      } else {
        pos = labelEnd + 1;
      }
    } else {
      pos = labelEnd + 1;
    }

    // covers label === '' and label === undefined
    // (collapsed reference link and shortcut reference link respectively)
    if (!label) label = state.src.slice(labelStart, labelEnd);

    const ref = state.references[normalizeReference(label)];
    if (!ref) {
      state.pos = oldPos;
      return false;
    }
    href = ref.href;
    title = ref.title;
  }

  //
  // We found the end of the link, and know for a fact it's a valid link;
  // so all that's left to do is to call tokenizer.
  //
  if (!silent) {
    state.pos = labelStart;
    state.posMax = labelEnd;

    const token = state.push(T.LINK_OPEN);
    token.href = href;
    token.title = title;

    state.tokenize();

    state.push(T.LINK_CLOSE);
  }

  state.pos = pos;
  state.posMax = max;
  return true;
}

function image(state: InlineState, silent: boolean): boolean {
  let href = '';
  let title: string;
  const oldPos = state.pos;
  const max = state.posMax;
  let label: string | undefined;
  let code: number;
  let start: number;

  if (state.src.charCodeAt(state.pos + 1) !== 0x5b /* [ */) return false;

  const labelStart = state.pos + 2;
  const labelEnd = parseLinkLabel(state, state.pos + 1, false);

  // parser failed to find ']', so it's not a valid link
  if (labelEnd < 0) return false;

  let pos = labelEnd + 1;
  if (pos < max && state.src.charCodeAt(pos) === 0x28 /* ( */) {
    //
    // Inline link
    //

    // [link](  <href>  "title"  )
    //        ^^ skipping these spaces
    pos++;
    for (; pos < max; pos++) {
      code = state.src.charCodeAt(pos);
      if (!isSpace(code) && code !== 0x0a) break;
    }
    if (pos >= max) return false;

    // [link](  <href>  "title"  )
    //          ^^^^^^ parsing link destination
    start = pos;
    let res = md.helpers.parseLinkDestination(state.src, pos, state.posMax);
    if (res.ok) {
      href = md.normalizeLink(res.str);
      if (md.validateLink(href)) {
        pos = res.pos;
      } else {
        href = '';
      }
    }

    // [link](  <href>  "title"  )
    //                ^^ skipping these spaces
    start = pos;
    for (; pos < max; pos++) {
      code = state.src.charCodeAt(pos);
      if (!isSpace(code) && code !== 0x0a) break;
    }

    // [link](  <href>  "title"  )
    //                  ^^^^^^^ parsing link title
    res = md.helpers.parseLinkTitle(state.src, pos, state.posMax);
    if (pos < max && start !== pos && res.ok) {
      title = res.str;
      pos = res.pos;

      // [link](  <href>  "title"  )
      //                         ^^ skipping these spaces
      for (; pos < max; pos++) {
        code = state.src.charCodeAt(pos);
        if (!isSpace(code) && code !== 0x0a) break;
      }
    } else {
      title = '';
    }

    if (pos >= max || state.src.charCodeAt(pos) !== 0x29 /* ) */) {
      state.pos = oldPos;
      return false;
    }
    pos++;
  } else {
    //
    // Link reference
    //
    if (state.references === undefined) return false;

    if (pos < max && state.src.charCodeAt(pos) === 0x5b /* [ */) {
      start = pos + 1;
      pos = parseLinkLabel(state, pos);
      if (pos >= 0) {
        label = state.src.slice(start, pos++);
      } else {
        pos = labelEnd + 1;
      }
    } else {
      pos = labelEnd + 1;
    }

    // covers label === '' and label === undefined
    // (collapsed reference link and shortcut reference link respectively)
    if (!label) label = state.src.slice(labelStart, labelEnd);

    const ref = state.references[normalizeReference(label)];
    if (!ref) {
      state.pos = oldPos;
      return false;
    }
    href = ref.href;
    title = ref.title;
  }

  //
  // We found the end of the link, and know for a fact it's a valid link.
  // markdown-it also parses the label into the image's `children`, which
  // Markdoc never reads (an image is a leaf node), so that step is skipped.
  //
  if (!silent) {
    const token = state.push(T.IMAGE);
    token.href = href;
    token.title = title;
    token.content = state.src.slice(labelStart, labelEnd);
  }

  state.pos = pos;
  state.posMax = max;
  return true;
}

// ---------------------------------------------------------------- autolink

const EMAIL_RE =
  /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
// eslint-disable-next-line no-control-regex
const AUTOLINK_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;

function autolink(state: InlineState, silent: boolean): boolean {
  let pos = state.pos;
  const start = state.pos;
  const max = state.posMax;

  for (;;) {
    if (++pos >= max) return false;

    const ch = state.src.charCodeAt(pos);

    if (ch === 0x3c /* < */) return false;
    if (ch === 0x3e /* > */) break;
  }

  const url = state.src.slice(start + 1, pos);

  if (AUTOLINK_RE.test(url)) {
    const fullUrl = md.normalizeLink(url);
    if (!md.validateLink(fullUrl)) return false;

    if (!silent) {
      let token = state.push(T.LINK_OPEN);
      token.href = fullUrl;
      token.markup = 'autolink';
      token.info = 'auto';

      token = state.push(T.TEXT);
      token.content = md.normalizeLinkText(url);

      token = state.push(T.LINK_CLOSE);
      token.markup = 'autolink';
      token.info = 'auto';
    }

    state.pos += url.length + 2;
    return true;
  }

  if (EMAIL_RE.test(url)) {
    const fullUrl = md.normalizeLink('mailto:' + url);
    if (!md.validateLink(fullUrl)) return false;

    if (!silent) {
      let token = state.push(T.LINK_OPEN);
      token.href = fullUrl;
      token.markup = 'autolink';
      token.info = 'auto';

      token = state.push(T.TEXT);
      token.content = md.normalizeLinkText(url);

      token = state.push(T.LINK_CLOSE);
      token.markup = 'autolink';
      token.info = 'auto';
    }

    state.pos += url.length + 2;
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- html_inline

// `HTML_TAG_RE` without its `^`, run sticky at `pos` rather than on
// `src.slice(pos)`: the same match, without copying the rest of the source.
const HTML_TAG_STICKY = new RegExp(HTML_TAG_RE.source.replace(/^\^/, ''), 'y');

function isLetter(ch: number) {
  const lc = ch | 0x20; // to lower case
  return lc >= 0x61 /* a */ && lc <= 0x7a /* z */;
}

function htmlInline(state: InlineState, silent: boolean): boolean {
  const pos = state.pos;

  if (!state.html) return false;

  // Check start
  const max = state.posMax;
  if (pos + 2 >= max) return false;

  // Quick fail on second char
  const ch = state.src.charCodeAt(pos + 1);
  if (
    ch !== 0x21 /* ! */ &&
    ch !== 0x3f /* ? */ &&
    ch !== 0x2f /* / */ &&
    !isLetter(ch)
  )
    return false;

  HTML_TAG_STICKY.lastIndex = pos;
  const match = HTML_TAG_STICKY.exec(state.src);
  if (!match) return false;

  if (!silent) {
    const token = state.push(T.HTML_INLINE);
    token.content = state.src.slice(pos, pos + match[0].length);
  }
  state.pos += match[0].length;
  return true;
}

// ---------------------------------------------------------------- entity

const DIGITAL_RE = /&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/iy;
const NAMED_RE = /&([a-z][a-z0-9]{1,31});/iy;

function entity(state: InlineState, silent: boolean): boolean {
  const pos = state.pos;
  const max = state.posMax;

  if (pos + 1 < max) {
    const ch = state.src.charCodeAt(pos + 1);

    if (ch === 0x23 /* # */) {
      DIGITAL_RE.lastIndex = pos;
      const match = DIGITAL_RE.exec(state.src);
      if (match) {
        if (!silent) {
          const code =
            match[1][0].toLowerCase() === 'x'
              ? parseInt(match[1].slice(1), 16)
              : parseInt(match[1], 10);
          state.pending += isValidEntityCode(code)
            ? fromCodePoint(code)
            : fromCodePoint(0xfffd);
        }
        state.pos += match[0].length;
        return true;
      }
    } else {
      NAMED_RE.lastIndex = pos;
      const match = NAMED_RE.exec(state.src);
      if (match) {
        if (Object.prototype.hasOwnProperty.call(entities, match[1])) {
          if (!silent) state.pending += (entities as any)[match[1]];
          state.pos += match[0].length;
          return true;
        }
      }
    }
  }

  if (!silent) state.pending += '&';
  state.pos++;
  return true;
}

// ---------------------------------------------------------------- Markdoc tags

function tag(state: InlineState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos + 1) !== 0x25 /* % */) return false;

  const tagEnd = findTagEnd(state.src, state.pos);
  if (!tagEnd) return false;

  const content = state.src.slice(state.pos + OPEN.length, tagEnd);
  if (!silent) {
    pushTag((type) => state.push(type), content.trim());
    // A closing tag with no opening one pops past the outermost delimiter
    // scope; Markdoc's `createToken` resets it the same way.
    if (!state.delimiters) state.delimiters = [];
  }

  state.pos = tagEnd + CLOSE.length;
  return true;
}

// ---------------------------------------------------------------- comments

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

function comment(state: InlineState, silent: boolean): boolean {
  if (!state.src.startsWith(COMMENT_OPEN, state.pos)) return false;

  const close = state.src.indexOf(COMMENT_CLOSE, state.pos);

  if (close === -1) return false;
  if (silent) return true;

  const content = state.src.slice(state.pos + COMMENT_OPEN.length, close);
  const token = state.push(T.COMMENT);
  token.content = content.trim();
  state.pos = close + COMMENT_CLOSE.length;

  return true;
}
