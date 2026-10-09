import MarkdownIt from 'markdown-it/lib';
import annotations from './plugins/annotations';
import frontmatter from './plugins/frontmatter';
import comments from './plugins/comments';
import link from './plugins/link';
import githubAdmonitions from './plugins/githubAdmonitions';
import stopAfterRule from './plugins/stopAfter';
import {
  countLines,
  extendPastOpenConstructs,
  frontmatterFloor,
  lineAlignedCut,
} from './prefix';
import type Token from 'markdown-it/lib/token';
import type { StopAfterEnv, StopAfterPredicate } from './plugins/stopAfter';

export type LinkPluginOptions = { validatedProtocols: string[] };

/** First prefix length to try. Large enough to cover a typical title block. */
const MIN_PREFIX = 512;
/** Geometric growth, so the number of attempts is logarithmic in the match depth. */
const PREFIX_GROWTH = 8;
/**
 * Give up on prefixes past this point and read the whole document instead.
 *
 * Each attempt re-tokenizes from the start, so the retries are pure overhead if
 * no prefix ever matches. Once a prefix approaches the document size the
 * remaining upside is small while that overhead keeps growing, so without a cap
 * a document whose match is deep (or absent) ends up ~2x slower than a plain
 * `stopAfter`. Capping bounds the wasted work to roughly this many bytes.
 */
const MAX_PREFIX = 32 * 1024;
/** Also stop early on small documents, where a prefix saves little. */
const MAX_PREFIX_FRACTION = 4;
/**
 * A prefix covering this much of the document is not worth tokenizing
 * separately: we would pay for it and then for the document anyway. Keeps a
 * document barely larger than `MIN_PREFIX` from costing ~2 passes.
 */
const USEFUL_PREFIX_RATIO = 0.75;
/**
 * A match is only trusted when block parsing finished this many lines before
 * the cut. Closer than that and the construct may have been truncated — a
 * paragraph that would have continued, for instance.
 */
const MARGIN_LINES = 2;

export type TokenizeOptions = {
  /**
   * Stop tokenizing as soon as a token matching this predicate has been
   * emitted. The returned tokens are byte-identical to the prefix a full parse
   * would produce, so e.g. `(t) => t.type === 'heading_close'` extracts the
   * first heading in a single pass without re-parsing.
   *
   * A document containing no matching token still costs a full parse.
   */
  stopAfter?: StopAfterPredicate;
};

export default class Tokenizer {
  private parser: MarkdownIt;

  constructor(
    config: MarkdownIt.Options & {
      allowIndentation?: boolean;
      allowComments?: boolean;
      allowLinkValidation?: boolean;
      linkValidationOptions?: LinkPluginOptions;
      githubAdmonitions?: boolean;
    } = {}
  ) {
    this.parser = new MarkdownIt(config);

    // Registered before any plugin so it sits first in the block ruler. Every
    // plugin below inserts itself before a rule that already follows this one
    // (`table`, `hr`, `paragraph`), so this stays at position 0. It is inert
    // unless `tokenize` is called with a `stopAfter` predicate.
    this.parser.block.ruler.before('table', 'stopAfter', stopAfterRule);

    this.parser.use(annotations, 'annotations', {});
    this.parser.use(frontmatter, 'frontmatter', {});

    this.parser.disable([
      'lheading',
      // Disable indented `code_block` support https://spec.commonmark.org/0.30/#indented-code-block
      'code',
    ]);

    if (config.allowComments) this.parser.use(comments, 'comments', {});
    if (config.allowLinkValidation) {
      // Set http and https as the default protocols to validate
      this.parser.use(
        link,
        config.linkValidationOptions ?? {
          validatedProtocols: ['http', 'https'],
        }
      );
    }
    // GitHub-style admonitions (`> [!NOTE]`) are recognized by default.
    // Pass `githubAdmonitions: false` to opt out.
    if (config.githubAdmonitions !== false)
      this.parser.use(githubAdmonitions, 'githubAdmonitions', {});
  }

  tokenize(content: string, options: TokenizeOptions = {}): Token[] {
    // Only seed the env when stopping is requested, so the default path passes
    // the same empty env it always has.
    const env = options.stopAfter
      ? { stopAfter: options.stopAfter, checked: 0 }
      : {};
    return this.parser.parse(content.toString(), env);
  }

  /**
   * Like `tokenize(content, { stopAfter })`, but the work is proportional to the
   * prefix up to the match rather than to `content.length`.
   *
   * `stopAfter` alone only short-circuits the block loop; `StateBlock` setup and
   * core `normalize` still run over the whole string, so a 570 KB document with
   * its heading on line 1 costs ~2 ms. This tokenizes growing line-aligned
   * prefixes instead, accepting one only when the match is far enough from the
   * cut to be unaffected by it, and falls back to a full `tokenize` when the
   * document holds no match. The matched token and everything before it are
   * identical to what `tokenize(content, { stopAfter })` returns.
   *
   * `createStopAfter` is a factory rather than a predicate because each attempt
   * re-tokenizes from the first token, so a stateful predicate (one tracking
   * `{% slot %}` depth, say) needs a fresh instance per attempt.
   *
   * As with `stopAfter`, enclosing blocks are closed wherever parsing stopped,
   * so their end maps are not meaningful.
   */
  tokenizeUntil(
    content: string,
    createStopAfter: () => StopAfterPredicate
  ): Token[] {
    const src = content.toString();

    // Frontmatter must be whole in the very first prefix: cut inside it and its
    // `# comment` lines silently become headings, far before the cut where no
    // distance check can see them.
    let size = Math.max(MIN_PREFIX, frontmatterFloor(src));
    const ceiling = Math.min(
      MAX_PREFIX,
      Math.ceil(src.length / MAX_PREFIX_FRACTION)
    );

    while (size < src.length) {
      const cut = extendPastOpenConstructs(src, lineAlignedCut(src, size));
      // Not enough of the document left out for the prefix to pay for itself.
      if (cut >= src.length * USEFUL_PREFIX_RATIO) break;
      // Past the ceiling, retrying costs more than it can save.
      if (cut > ceiling && size > MIN_PREFIX) break;

      const prefix = src.slice(0, cut);
      const env: StopAfterEnv = { stopAfter: createStopAfter(), checked: 0 };
      const tokens = this.parser.parse(prefix, env);

      if (
        env.stopped &&
        (env.stoppedLine ?? Infinity) < countLines(prefix) - MARGIN_LINES
      )
        return tokens;

      size = Math.max(cut + 1, size * PREFIX_GROWTH);
    }

    // No prefix sufficed, so this is the whole document. Identical to calling
    // `tokenize` with the predicate directly.
    return this.tokenize(src, { stopAfter: createStopAfter() });
  }
}
