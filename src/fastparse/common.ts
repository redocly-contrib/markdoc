/**
 * The helpers the parser shares with markdown-it 12.3.2 — character classes,
 * entity and escape decoding, link destination/title parsing, URL
 * normalization and the HTML patterns — ported from markdown-it (MIT,
 * Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin) so the parser does not
 * depend on it. They use the same `entities`, `mdurl`, `punycode` and
 * `uc.micro` packages markdown-it does, so results are identical.
 */
import entities from 'entities/lib/maps/entities.json';
import mdurl from 'mdurl';
// The npm package, not Node's deprecated built-in module of the same name.
import punycode from 'punycode/punycode.js';
import UNICODE_PUNCT_RE from 'uc.micro/categories/P/regex';

export { entities };

export function has(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isValidEntityCode(c: number): boolean {
  /*eslint no-bitwise:0*/
  // broken sequence
  if (c >= 0xd800 && c <= 0xdfff) return false;
  // never used
  if (c >= 0xfdd0 && c <= 0xfdef) return false;
  if ((c & 0xffff) === 0xffff || (c & 0xffff) === 0xfffe) return false;
  // control codes
  if (c >= 0x00 && c <= 0x08) return false;
  if (c === 0x0b) return false;
  if (c >= 0x0e && c <= 0x1f) return false;
  if (c >= 0x7f && c <= 0x9f) return false;
  // out of range
  if (c > 0x10ffff) return false;
  return true;
}

export function fromCodePoint(c: number): string {
  if (c > 0xffff) {
    c -= 0x10000;
    const surrogate1 = 0xd800 + (c >> 10);
    const surrogate2 = 0xdc00 + (c & 0x3ff);
    return String.fromCharCode(surrogate1, surrogate2);
  }
  return String.fromCharCode(c);
}

const UNESCAPE_MD_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const ENTITY_RE = /&([a-z#][a-z0-9]{1,31});/gi;
const UNESCAPE_ALL_RE = new RegExp(
  UNESCAPE_MD_RE.source + '|' + ENTITY_RE.source,
  'gi'
);
const DIGITAL_ENTITY_TEST_RE = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))/i;

function replaceEntityPattern(match: string, name: string): string {
  if (has(entities, name)) return (entities as Record<string, string>)[name];

  if (
    name.charCodeAt(0) === 0x23 /* # */ &&
    DIGITAL_ENTITY_TEST_RE.test(name)
  ) {
    const code =
      name[1].toLowerCase() === 'x'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);

    if (isValidEntityCode(code)) return fromCodePoint(code);
  }

  return match;
}

export function unescapeAll(str: string): string {
  if (str.indexOf('\\') < 0 && str.indexOf('&') < 0) return str;

  return str.replace(
    UNESCAPE_ALL_RE,
    (match: string, escaped: string, entity: string) => {
      if (escaped) return escaped;
      return replaceEntityPattern(match, entity);
    }
  );
}

export function isSpace(code: number): boolean {
  return code === 0x09 || code === 0x20;
}

// Zs (unicode class) || [\t\f\v\r\n]
export function isWhiteSpace(code: number): boolean {
  if (code >= 0x2000 && code <= 0x200a) return true;
  switch (code) {
    case 0x09: // \t
    case 0x0a: // \n
    case 0x0b: // \v
    case 0x0c: // \f
    case 0x0d: // \r
    case 0x20:
    case 0xa0:
    case 0x1680:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return false;
}

// Currently without astral characters support.
export function isPunctChar(ch: string): boolean {
  return UNICODE_PUNCT_RE.test(ch);
}

// Markdown ASCII punctuation characters.
//
// !, ", #, $, %, &, ', (, ), *, +, ,, -, ., /, :, ;, <, =, >, ?, @, [, \, ], ^, _, `, {, |, }, or ~
// http://spec.commonmark.org/0.15/#ascii-punctuation-character
//
// Don't confuse with unicode punctuation !!! It lacks some chars in ascii range.
//
export function isMdAsciiPunct(ch: number): boolean {
  switch (ch) {
    case 0x21 /* ! */:
    case 0x22 /* " */:
    case 0x23 /* # */:
    case 0x24 /* $ */:
    case 0x25 /* % */:
    case 0x26 /* & */:
    case 0x27 /* ' */:
    case 0x28 /* ( */:
    case 0x29 /* ) */:
    case 0x2a /* * */:
    case 0x2b /* + */:
    case 0x2c /* , */:
    case 0x2d /* - */:
    case 0x2e /* . */:
    case 0x2f /* / */:
    case 0x3a /* : */:
    case 0x3b /* ; */:
    case 0x3c /* < */:
    case 0x3d /* = */:
    case 0x3e /* > */:
    case 0x3f /* ? */:
    case 0x40 /* @ */:
    case 0x5b /* [ */:
    case 0x5c /* \ */:
    case 0x5d /* ] */:
    case 0x5e /* ^ */:
    case 0x5f /* _ */:
    case 0x60 /* ` */:
    case 0x7b /* { */:
    case 0x7c /* | */:
    case 0x7d /* } */:
    case 0x7e /* ~ */:
      return true;
    default:
      return false;
  }
}

// Helper to unify [reference labels].
export function normalizeReference(str: string): string {
  // Trim and collapse whitespace
  //
  str = str.trim().replace(/\s+/g, ' ');

  // In node v10 'ẞ'.toLowerCase() === 'Ṿ', which is presumed to be a bug
  // fixed in v12 (couldn't find any details).
  //
  // So treat this one as a special case
  // (remove this when node v10 is no longer supported).
  //
  if ('ẞ'.toLowerCase() === 'Ṿ') {
    str = str.replace(/ẞ/g, 'ß');
  }

  // .toLowerCase().toUpperCase() should get rid of all differences
  // between letter variants.
  //
  // Simple .toLowerCase() doesn't normalize 125 code points correctly,
  // and .toUpperCase doesn't normalize 6 of them (list of exceptions:
  // İ, ϴ, ẞ, Ω, K, Å - those are already uppercased, but have differently
  // uppercased versions).
  //
  // Here's an example showing how it happens. Lets take greek letter omega:
  // uppercase U+0398 (Θ), U+03f4 (ϴ) and lowercase U+03b8 (θ), U+03d1 (ϑ)
  //
  // Unicode entries:
  // 0398;GREEK CAPITAL LETTER THETA;Lu;0;L;;;;;N;;;;03B8;
  // 03B8;GREEK SMALL LETTER THETA;Ll;0;L;;;;;N;;;0398;;0398
  // 03D1;GREEK THETA SYMBOL;Ll;0;L;<compat> 03B8;;;;N;GREEK SMALL LETTER SCRIPT THETA;;0398;;0398
  // 03F4;GREEK CAPITAL THETA SYMBOL;Lu;0;L;<compat> 0398;;;;N;;;;03B8;
  //
  // Case-insensitive comparison should treat all of them as equivalent.
  //
  // But .toLowerCase() doesn't change ϑ (it's already lowercase),
  // and .toUpperCase() doesn't change ϴ (already uppercase).
  //
  // Applying first lower then upper case normalizes any character:
  // 'Θϴθϑ'.toLowerCase().toUpperCase() === 'ΘΘΘΘ'
  //
  // Note: this is equivalent to unicode case folding; unicode normalization
  // is a different step that is not required here.
  //
  // Final result should be uppercased, because it's later stored in an object
  // (this avoid a conflict with Object.prototype members,
  // most notably, `__proto__`)
  //
  return str.toLowerCase().toUpperCase();
}

// ---------------------------------------------------------------- link helpers

export type LinkResult = {
  ok: boolean;
  pos: number;
  lines: number;
  str: string;
};

// Parse link destination
export function parseLinkDestination(
  str: string,
  pos: number,
  max: number
): LinkResult {
  let code: number;
  let level: number;
  const lines = 0;
  const start = pos;
  const result: LinkResult = { ok: false, pos: 0, lines: 0, str: '' };

  if (str.charCodeAt(pos) === 0x3c /* < */) {
    pos++;
    while (pos < max) {
      code = str.charCodeAt(pos);
      if (code === 0x0a /* \n */) return result;
      if (code === 0x3c /* < */) return result;
      if (code === 0x3e /* > */) {
        result.pos = pos + 1;
        result.str = unescapeAll(str.slice(start + 1, pos));
        result.ok = true;
        return result;
      }
      if (code === 0x5c /* \ */ && pos + 1 < max) {
        pos += 2;
        continue;
      }

      pos++;
    }

    // no closing '>'
    return result;
  }

  // this should be ... } else { ... branch

  level = 0;
  while (pos < max) {
    code = str.charCodeAt(pos);

    if (code === 0x20) break;

    // ascii control characters
    if (code < 0x20 || code === 0x7f) break;

    if (code === 0x5c /* \ */ && pos + 1 < max) {
      if (str.charCodeAt(pos + 1) === 0x20) break;
      pos += 2;
      continue;
    }

    if (code === 0x28 /* ( */) {
      level++;
      if (level > 32) return result;
    }

    if (code === 0x29 /* ) */) {
      if (level === 0) break;
      level--;
    }

    pos++;
  }

  if (start === pos) return result;
  if (level !== 0) return result;

  result.str = unescapeAll(str.slice(start, pos));
  result.lines = lines;
  result.pos = pos;
  result.ok = true;
  return result;
}

// Parse link title
export function parseLinkTitle(
  str: string,
  pos: number,
  max: number
): LinkResult {
  let code: number;
  let lines = 0;
  const start = pos;
  const result: LinkResult = { ok: false, pos: 0, lines: 0, str: '' };

  if (pos >= max) return result;

  let marker = str.charCodeAt(pos);

  if (
    marker !== 0x22 /* " */ &&
    marker !== 0x27 /* ' */ &&
    marker !== 0x28 /* ( */
  )
    return result;

  pos++;

  // if opening marker is "(", switch it to closing marker ")"
  if (marker === 0x28) marker = 0x29;

  while (pos < max) {
    code = str.charCodeAt(pos);
    if (code === marker) {
      result.pos = pos + 1;
      result.lines = lines;
      result.str = unescapeAll(str.slice(start + 1, pos));
      result.ok = true;
      return result;
    } else if (code === 0x28 /* ( */ && marker === 0x29 /* ) */) {
      return result;
    } else if (code === 0x0a) {
      lines++;
    } else if (code === 0x5c /* \ */ && pos + 1 < max) {
      pos++;
      if (str.charCodeAt(pos) === 0x0a) lines++;
    }

    pos++;
  }

  return result;
}

// ---------------------------------------------------------------- URLs

const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;

function validateLinkUncached(url: string): boolean {
  // url should be normalized at this point, and existing entities are decoded
  const str = url.trim().toLowerCase();

  return BAD_PROTO_RE.test(str)
    ? GOOD_DATA_RE.test(str)
      ? true
      : false
    : true;
}

const RECODE_HOSTNAME_FOR = ['http:', 'https:', 'mailto:'];

function normalizeLinkUncached(url: string): string {
  const parsed = mdurl.parse(url, true);

  if (parsed.hostname) {
    // Encode hostnames in urls like:
    // `http://host/`, `https://host/`, `mailto:user@host`, `//host/`
    //
    // We don't encode unknown schemas, because it's likely that we encode
    // something we shouldn't (e.g. `skype:name` treated as `skype:host`)
    //
    if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) {
      try {
        parsed.hostname = punycode.toASCII(parsed.hostname);
      } catch {
        /**/
      }
    }
  }

  return mdurl.encode(mdurl.format(parsed));
}

function normalizeLinkTextUncached(url: string): string {
  const parsed = mdurl.parse(url, true);

  if (parsed.hostname) {
    // Encode hostnames in urls like:
    // `http://host/`, `https://host/`, `mailto:user@host`, `//host/`
    //
    // We don't encode unknown schemas, because it's likely that we encode
    // something we shouldn't (e.g. `skype:name` treated as `skype:host`)
    //
    if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) {
      try {
        parsed.hostname = punycode.toUnicode(parsed.hostname);
      } catch {
        /**/
      }
    }
  }

  // add '%' to exclude list because of https://github.com/markdown-it/markdown-it/issues/720
  return mdurl.decode(mdurl.format(parsed), mdurl.decode.defaultChars + '%');
}

/**
 * The link helpers are pure functions of the URL, and the same URLs recur
 * across a site's pages, so their results are memoized.
 */
function memoize<T>(fn: (url: string) => T): (url: string) => T {
  const cache = new Map<string, T>();
  return (url) => {
    let result = cache.get(url);
    if (result === undefined) {
      if (cache.size >= 4096) cache.clear();
      result = fn(url);
      cache.set(url, result);
    }
    return result;
  };
}

export const normalizeLink = memoize(normalizeLinkUncached);
export const validateLink = memoize(validateLinkUncached);
export const normalizeLinkText = memoize(normalizeLinkTextUncached);

// ---------------------------------------------------------------- HTML

// List of valid html blocks names, according to commonmark spec
// http://jgm.github.io/CommonMark/spec.html#html-blocks
export const HTML_BLOCK_NAMES = [
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'section',
  'source',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
];

// Regexps to match html elements
const attrName = '[a-zA-Z_:][a-zA-Z0-9:._-]*';

const unquoted = '[^"\'=<>`\\x00-\\x20]+';
const singleQuoted = "'[^']*'";
const doubleQuoted = '"[^"]*"';

const attrValue =
  '(?:' + unquoted + '|' + singleQuoted + '|' + doubleQuoted + ')';

const attribute = '(?:\\s+' + attrName + '(?:\\s*=\\s*' + attrValue + ')?)';

const openTag = '<[A-Za-z][A-Za-z0-9\\-]*' + attribute + '*\\s*\\/?>';

const closeTag = '<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>';
const comment = '<!---->|<!--(?:-?[^>-])(?:-?[^-])*-->';
const processing = '<[?][\\s\\S]*?[?]>';
const declaration = '<![A-Z]+\\s+[^>]*>';
const cdata = '<!\\[CDATA\\[[\\s\\S]*?\\]\\]>';

export const HTML_TAG_RE = new RegExp(
  '^(?:' +
    openTag +
    '|' +
    closeTag +
    '|' +
    comment +
    '|' +
    processing +
    '|' +
    declaration +
    '|' +
    cdata +
    ')'
);
export const HTML_OPEN_CLOSE_TAG_RE = new RegExp(
  '^(?:' + openTag + '|' + closeTag + ')'
);
