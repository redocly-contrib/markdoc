/**
 * Raw HTML as Markdoc `html` tags, for `parse(source, { html: htmlTags() })`.
 *
 * Each HTML element becomes an `{% html %}` tag with two attributes: `name`
 * (the element name) and `attrs` (its attributes as React props, see
 * `getJsxConvertedAttributes`). Markdown between an element's opening and
 * closing tags becomes the tag's children, so
 *
 *     <details>
 *
 *     **Bold** text
 *
 *     </details>
 *
 * is an `html` tag named `details` holding a paragraph. HTML is parsed with
 * htmlparser2, so elements close as browsers close them (implied closes,
 * void elements), names are lowercased and entities in attributes decoded.
 *
 * - An element left open at the end of its run (the document's HTML blocks,
 *   or one paragraph's inline HTML) is closed there, innermost first, each
 *   after an `errorTag` tag inside it carrying a `message` attribute.
 * - A tag whose name cannot be a React element name (`GridItem\<T\>` written
 *   in an HTML block, say) stays text, as written.
 * - Text inside HTML that is only whitespace is dropped.
 */
import { Parser } from 'htmlparser2';
import { getJsxConvertedAttributes } from './attributes';

import type { HtmlHandler, HtmlRun, HtmlToken } from '../types';

export { getJsxConvertedAttributes };

export type HtmlTagsOptions = {
  /** The tag that reports an unclosed element. @default 'markdoc-error' */
  errorTag?: string;
};

// React's rule: any other name fails the whole render.
const ELEMENT_NAME_RE = /^[a-zA-Z][a-zA-Z:_.\-\d]*$/;

export function htmlTags({
  errorTag = 'markdoc-error',
}: HtmlTagsOptions = {}): HtmlHandler {
  return { start: () => run(errorTag) };
}

function run(errorTag: string): HtmlRun {
  let output: HtmlToken[] = [];
  const openedStack: { name: string; element: boolean }[] = [];
  let written = '';
  // Set at the end of the run, when htmlparser2 closes what is still open.
  let ending = false;
  const writtenTag = () =>
    written.slice(parser.startIndex, parser.endIndex + 1);

  const parser = new Parser({
    onopentag(name, attrs) {
      const element = ELEMENT_NAME_RE.test(name);
      openedStack.push({ name, element });
      if (!element) {
        output.push({ type: 'text', content: writtenTag() });
        return;
      }
      output.push({
        type: 'tag_open',
        nesting: 1,
        meta: {
          tag: 'html',
          attributes: [
            { type: 'attribute', name: 'name', value: name },
            {
              type: 'attribute',
              name: 'attrs',
              value: getJsxConvertedAttributes(attrs, name),
            },
          ],
        },
      });
    },

    ontext(content) {
      if (content.trim().length > 0) output.push({ type: 'text', content });
    },

    onclosetag(_name, isImplied) {
      // htmlparser2 always pairs this with an earlier onopentag, so no mismatch check.
      const opened = openedStack.pop();
      if (opened?.element === false) {
        if (!isImplied) output.push({ type: 'text', content: writtenTag() });
        return;
      }
      if (ending && opened)
        output.push(
          {
            type: 'tag_open',
            nesting: 1,
            meta: {
              tag: errorTag,
              attributes: [
                {
                  type: 'attribute',
                  name: 'message',
                  value: `HTML element <${opened.name}> is not closed`,
                },
              ],
            },
          },
          { type: 'tag_close', nesting: -1, meta: { tag: errorTag } }
        );
      output.push({ type: 'tag_close', nesting: -1, meta: { tag: 'html' } });
    },
  });

  return {
    write(html) {
      written += html;
      parser.write(html);
      const tokens = output;
      output = [];
      return tokens;
    },
    end() {
      // htmlparser2 then emits the text it held back (a possible entity at
      // the end) and closes the open elements, innermost first.
      ending = true;
      parser.end();
      return output;
    },
  };
}
