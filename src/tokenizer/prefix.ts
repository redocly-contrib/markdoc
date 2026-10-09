import { OPEN, CLOSE } from '../utils';

/**
 * Helpers for choosing where a source prefix may safely be cut.
 *
 * `tokenize(src, { stopAfter })` stops the block loop early but still pays
 * `StateBlock` setup and core `normalize` over the whole string, both of which
 * are O(src.length). Tokenizing a short prefix avoids that — but only if the
 * cut cannot change how the kept tokens are parsed.
 *
 * Markdoc has no setext headings and block parsing is forward-only, so a later
 * line can never retroactively change an earlier one. The one hazard is a block
 * rule that must see a *closing* delimiter: cut it in half and the rule fails,
 * and its body is re-parsed as ordinary markdown. That invents tokens — a `#`
 * line inside frontmatter or inside an HTML comment becomes a real heading — so
 * a prefix must never end inside one of these.
 */

/** Opener/closer pairs whose block rule fails (rather than consuming to EOF)
 *  when the closer is missing. Only line-initial openers matter: the block
 *  rules require the opener at the start of a line, and an inline construct cut
 *  in half degrades to text, which cannot invent a block token. */
const LOOKAHEAD_PAIRS: readonly [string, string][] = [
  [OPEN, CLOSE], // {% tag ... %} — a multi-line opening
  ['<!--', '-->'], // HTML comment
];

const FRONTMATTER_FENCE = '---';

/** Index just past the end of the line containing `index`. */
function endOfLine(src: string, index: number): number {
  const nl = src.indexOf('\n', index);
  return nl === -1 ? src.length : nl + 1;
}

/** A cut must land on a line boundary, since block rules reason about lines. */
export function lineAlignedCut(src: string, from: number): number {
  if (from >= src.length) return src.length;
  return endOfLine(src, from);
}

/**
 * Frontmatter is only recognized when its closing `---` is present. A prefix
 * that ends inside it turns every `# yaml comment` line into a heading, and no
 * distance-from-the-cut heuristic can detect that, because the bogus heading
 * sits far *before* the cut. So the first prefix must always reach past the
 * closing fence.
 *
 * Returns the smallest prefix length that contains the whole frontmatter block,
 * or 0 when the source does not open with one.
 */
export function frontmatterFloor(src: string): number {
  const firstLineEnd = endOfLine(src, 0);
  if (src.slice(0, firstLineEnd).trim() !== FRONTMATTER_FENCE) return 0;

  let pos = firstLineEnd;
  while (pos < src.length) {
    const lineEnd = endOfLine(src, pos);
    if (src.slice(pos, lineEnd).trim() === FRONTMATTER_FENCE) return lineEnd;
    pos = lineEnd;
  }
  // Never closed: the rule will fail no matter where we cut, so any prefix
  // behaves like the full document here.
  return 0;
}

/** Is `index` the start of a line, ignoring indentation? */
function isLineInitial(src: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (src[i] === ' ' || src[i] === '\t')) i--;
  return i < 0 || src[i] === '\n';
}

/**
 * Extends `cut` so the prefix does not end inside any look-ahead construct.
 * Repeats until stable, since extending past one closer can reveal another.
 */
export function extendPastOpenConstructs(src: string, cut: number): number {
  let result = Math.min(cut, src.length);

  for (let guard = 0; guard < LOOKAHEAD_PAIRS.length + 1; guard++) {
    let grew = false;

    for (const [open, close] of LOOKAHEAD_PAIRS) {
      // Walk back to the last line-initial opener inside the prefix.
      let at = src.lastIndexOf(open, result - 1);
      while (at !== -1 && !isLineInitial(src, at))
        at = src.lastIndexOf(open, at - 1);
      if (at === -1) continue;

      const closeAt = src.indexOf(close, at + open.length);
      // Closed within the prefix — nothing is cut.
      if (closeAt !== -1 && closeAt + close.length <= result) continue;
      // Never closed anywhere: no prefix can satisfy this rule, so stop
      // extending and let the caller fall back to the full document.
      if (closeAt === -1) return src.length;

      const extended = endOfLine(src, closeAt + close.length);
      if (extended > result) {
        result = extended;
        grew = true;
      }
    }

    if (!grew) break;
  }

  return Math.min(result, src.length);
}

/** Number of lines in `src`, matching how markdown-it indexes them. */
export function countLines(src: string): number {
  let lines = 1;
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lines++;
  return lines;
}
