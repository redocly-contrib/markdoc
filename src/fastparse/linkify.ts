/**
 * GitHub-flavored autolinks: bare `www.`, `http://`, `https://`, `ftp://` and
 * email addresses become links, following GitHub's own implementation (the
 * cmark-gfm autolink extension) rather than linkify-it's fuzzy matching:
 *
 * - `www.example.com` links only at the start of the text, after whitespace,
 *   or after `*`, `_`, `~` or `(`, and its href gets `http://`;
 * - a URL needs one of the three schemes followed by a letter or digit;
 * - the link runs to the next whitespace or `<`, then trailing `?!.,:*_~'"`,
 *   a trailing `&entity;` and unbalanced closing parentheses are trimmed
 *   back off, and the last two domain labels may not contain `_`;
 * - an email address is `[alnum.+-_]+@[alnum-_]+(\.[alnum-_]+)+` that ends in
 *   a letter (or a trimmed `.`), and its href gets `mailto:`.
 *
 * URLs are matched on the source text and taken verbatim, so markdown inside
 * one (`_`, `*`, `\`) is part of the link. Nothing is linked inside a link,
 * an image or code.
 */
import {
  isWhiteSpace,
  isPunctChar,
  normalizeLink,
  validateLink,
} from './common';
import * as T from './tokens';
import type { InlineState } from './inline';
import { InlineToken } from './tokens';

function isAlpha(c: number) {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAlnum(c: number) {
  return isAlpha(c) || (c >= 0x30 && c <= 0x39);
}

// cmark's `cmark_isspace`: ASCII whitespace only.
function isSpace(c: number) {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

// cmark's `ispunct`: every printable ASCII character that is not a letter,
// digit or space.
function isAsciiPunct(c: number) {
  return (
    (c >= 0x21 && c <= 0x2f) ||
    (c >= 0x3a && c <= 0x40) ||
    (c >= 0x5b && c <= 0x60) ||
    (c >= 0x7b && c <= 0x7e)
  );
}

/** A character a host name may contain: not whitespace, not punctuation. */
function isHostChar(str: string, at: number): boolean {
  const c = str.codePointAt(at) as number;
  if (c < 0x80) return !isSpace(c) && !isAsciiPunct(c);
  return !isWhiteSpace(c) && !isPunctChar(String.fromCodePoint(c));
}

/**
 * cmark-gfm's `check_domain`: the length of the domain at `start`, or 0. A
 * domain without a dot only counts when `allowShort`. As in cmark-gfm, the
 * last character of the text is never examined here.
 */
function checkDomain(
  str: string,
  start: number,
  end: number,
  allowShort: boolean
): number {
  let dots = 0;
  let underscores1 = 0;
  let underscores2 = 0;
  const size = end - start;
  let i = 1;
  for (; i < size - 1; i++) {
    const c = str.charCodeAt(start + i);
    if (c === 0x5c /* \ */ && i < size - 2) i++;
    const d = str.charCodeAt(start + i);
    if (d === 0x5f /* _ */) underscores2++;
    else if (d === 0x2e /* . */) {
      underscores1 = underscores2;
      underscores2 = 0;
      dots++;
    } else if (!isHostChar(str, start + i) && d !== 0x2d /* - */) break;
  }
  // An underscore in either of the last two labels makes it a domain but not
  // a host name. Very long names are accepted anyway, as GitHub does, to keep
  // this linear.
  if ((underscores1 > 0 || underscores2 > 0) && dots <= 10) return 0;
  if (allowShort) return i;
  return dots ? i : 0;
}

/** cmark-gfm's `autolink_delim`: trims trailing characters off a link. */
function trimEnd(str: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (str.charCodeAt(i) === 0x3c /* < */) {
      end = i;
      break;
    }
  }

  // Parentheses in the link, counted at the first trailing `)`. Only that
  // branch trims one, so the counts stay current without a recount.
  let opening = -1;
  let closing = 0;
  while (end > start) {
    const last = str.charCodeAt(end - 1);
    if ('?!.,:*_~\'"'.indexOf(str[end - 1]) !== -1) {
      end--;
    } else if (last === 0x3b /* ; */) {
      // A trailing entity reference such as `&amp;` is not part of the link.
      let entityStart = end - 2;
      while (entityStart > start && isAlpha(str.charCodeAt(entityStart)))
        entityStart--;
      if (entityStart < end - 2 && str.charCodeAt(entityStart) === 0x26 /* & */)
        end = entityStart;
      else end--;
    } else if (last === 0x29 /* ) */) {
      if (opening < 0) {
        opening = 0;
        for (let i = start; i < end; i++) {
          const c = str.charCodeAt(i);
          if (c === 0x28) opening++;
          else if (c === 0x29) closing++;
        }
      }
      if (closing <= opening) break;
      closing--;
      end--;
    } else break;
  }

  return end - start;
}

function scanToEnd(str: string, at: number, end: number): number {
  while (at < end) {
    const c = str.charCodeAt(at);
    if (isSpace(c) || c === 0x3c /* < */) break;
    at++;
  }
  return at;
}

function pushLink(state: InlineState, href: string, text: string) {
  const open = state.push(T.LINK_OPEN);
  open.href = href;
  open.markup = 'linkify';
  open.info = 'auto';
  const content = state.push(T.TEXT);
  content.content = text;
  const close = state.push(T.LINK_CLOSE);
  close.markup = 'linkify';
  close.info = 'auto';
}

/** `www.` links, tried at a `w`. */
export function www(state: InlineState, silent: boolean): boolean {
  // Bracket matching in link labels runs silently; autolinks never change it.
  if (silent || state.linkLevel > 0) return false;

  const src = state.src;
  const start = state.pos;
  const end = state.posMax;

  if (start > 0) {
    const previous = src.charCodeAt(start - 1);
    if ('*_~('.indexOf(src[start - 1]) === -1 && !isSpace(previous))
      return false;
  }
  if (end - start < 4 || !src.startsWith('www.', start)) return false;

  let length = checkDomain(src, start, end, false);
  if (length === 0) return false;
  length = scanToEnd(src, start + length, end) - start;
  length = trimEnd(src, start, start + length);
  if (length === 0) return false;

  const text = src.slice(start, start + length);
  const href = normalizeLink('http://' + text);
  if (!validateLink(href)) return false;

  pushLink(state, href, text);
  state.pos = start + length;
  return true;
}

const SCHEMES = ['http://', 'https://', 'ftp://'];

/** `http://`, `https://` and `ftp://` links, tried at a `:`. */
export function url(state: InlineState, silent: boolean): boolean {
  if (silent || state.linkLevel > 0) return false;

  const src = state.src;
  const colon = state.pos;
  const end = state.posMax;

  if (end - colon < 4) return false;
  if (src.charCodeAt(colon + 1) !== 0x2f || src.charCodeAt(colon + 2) !== 0x2f)
    return false;

  // The scheme is the run of letters right before the colon, which the text
  // rule has already collected into `pending`.
  let rewind = 0;
  while (rewind < colon && isAlpha(src.charCodeAt(colon - rewind - 1)))
    rewind++;
  const start = colon - rewind;
  const scheme = src.slice(start, colon + 3).toLowerCase();
  if (SCHEMES.indexOf(scheme) === -1) return false;
  if (end - start <= scheme.length || !isAlnum(src.charCodeAt(colon + 3)))
    return false;
  if (!state.pending.endsWith(src.slice(start, colon))) return false;

  const domain = checkDomain(src, colon + 3, end, true);
  if (domain === 0) return false;
  let length = scanToEnd(src, colon + 3 + domain, end) - start;
  length = trimEnd(src, start, start + length);
  if (length === 0) return false;

  const text = src.slice(start, start + length);
  const href = normalizeLink(text);
  if (!validateLink(href)) return false;

  state.pending = state.pending.slice(0, state.pending.length - rewind);
  pushLink(state, href, text);
  state.pos = start + length;
  return true;
}

/**
 * cmark-gfm's email pass: finds the first email address in `str` at or after
 * `offset`, as `[start, end]`, or undefined.
 */
function findEmail(str: string, offset: number): [number, number] | undefined {
  for (;;) {
    const at = str.indexOf('@', offset);
    if (at === -1) return undefined;

    let rewind = 0;
    while (rewind < at - offset) {
      const c = str.charCodeAt(at - rewind - 1);
      if (isAlnum(c) || '.+-_'.indexOf(str[at - rewind - 1]) !== -1) {
        rewind++;
        continue;
      }
      break;
    }

    if (rewind > 0) {
      let at2 = 0;
      let dots = 0;
      let end = at;
      for (; end < str.length; end++) {
        const c = str.charCodeAt(end);
        if (isAlnum(c)) continue;
        if (c === 0x40 /* @ */) {
          // A second `@` rules the address out, so stop there rather than
          // scan on: `a@a@a@…` would otherwise take quadratic time.
          if (++at2 > 1) break;
        } else if (
          c === 0x2e /* . */ &&
          end < str.length - 1 &&
          isAlnum(str.charCodeAt(end + 1))
        )
          dots++;
        else if (c !== 0x2d /* - */ && c !== 0x5f /* _ */) break;
      }
      const lastChar = str.charCodeAt(end - 1);
      if (
        end - at >= 2 &&
        at2 === 1 &&
        dots > 0 &&
        (isAlpha(lastChar) || lastChar === 0x2e) /* . */
      ) {
        const length = trimEnd(str, at, end);
        if (length > 0) return [at - rewind, at + length];
      }
    }

    offset = at + 1;
  }
}

/** Splits text tokens around email addresses, outside links. */
export function emails(state: InlineState) {
  const tokens = state.pool;
  const length = state.length;

  let any = false;
  for (let i = 0; i < length; i++) {
    if (tokens[i].type === T.TEXT && tokens[i].content.indexOf('@') !== -1) {
      any = true;
      break;
    }
  }
  if (!any) return;

  const output: InlineToken[] = [];
  const spare: InlineToken[] = [];
  let linkDepth = 0;

  const text = (content: string) => {
    const token = spare.pop() ?? new InlineToken();
    token.type = T.TEXT;
    token.content = content;
    token.info = '';
    token.markup = '';
    token.href = '';
    token.title = '';
    token.meta = null;
    token.delimiters = null;
    return token;
  };

  for (let i = 0; i < length; i++) {
    const token = tokens[i];
    if (token.type === T.LINK_OPEN) linkDepth++;
    else if (token.type === T.LINK_CLOSE) linkDepth--;

    if (token.type !== T.TEXT || linkDepth > 0) {
      output.push(token);
      continue;
    }

    const content = token.content;
    let from = 0;
    let match = findEmail(content, 0);
    if (!match) {
      output.push(token);
      continue;
    }

    spare.push(token);
    while (match) {
      const [start, end] = match;
      const address = content.slice(start, end);
      const href = normalizeLink('mailto:' + address);
      if (validateLink(href)) {
        if (start > from) output.push(text(content.slice(from, start)));
        const open = text('');
        open.type = T.LINK_OPEN;
        open.href = href;
        open.markup = 'linkify';
        open.info = 'auto';
        output.push(open, text(address));
        const close = text('');
        close.type = T.LINK_CLOSE;
        output.push(close);
        from = end;
      }
      match = findEmail(content, end);
    }
    if (from < content.length) output.push(text(content.slice(from)));
  }

  // Keep every token object in the pool for reuse.
  for (let i = length; i < tokens.length; i++) spare.push(tokens[i]);
  state.pool = output.concat(spare);
  state.length = output.length;
}
