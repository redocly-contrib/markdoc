import MarkdownIt from 'markdown-it/lib';
import annotations from './plugins/annotations';
import frontmatter from './plugins/frontmatter';
import comments from './plugins/comments';
import link from './plugins/link';
import githubAdmonitions from './plugins/githubAdmonitions';
import stopAfterRule from './plugins/stopAfter';
import type Token from 'markdown-it/lib/token';
import type { StopAfterPredicate } from './plugins/stopAfter';

export type LinkPluginOptions = { validatedProtocols: string[] };

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
}
