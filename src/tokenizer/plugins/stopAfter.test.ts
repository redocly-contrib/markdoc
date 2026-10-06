import Tokenizer from '../index';

import type Token from 'markdown-it/lib/token';

const stopAfterHeading = (token: Token) => token.type === 'heading_close';

describe('tokenize stopAfter', function () {
  const tokenizer = new Tokenizer({ allowComments: true });

  function both(src: string) {
    return {
      stopped: tokenizer.tokenize(src, { stopAfter: stopAfterHeading }),
      full: tokenizer.tokenize(src),
    };
  }

  function headingTag(tokens: Token[]) {
    return tokens.find((t) => t.type === 'heading_open')?.tag;
  }

  function headingText(tokens: Token[]) {
    const i = tokens.findIndex((t) => t.type === 'heading_open');
    return i === -1 ? undefined : tokens[i + 1]?.content;
  }

  it('ignores `#` lines inside a fenced code block', function () {
    const src = [
      '```js',
      '# not a heading',
      '# also not a heading',
      '```',
      '',
      '## Real Heading',
      '',
      'Body paragraph.',
      '',
      '## Second Heading',
      '',
      'More body.',
    ].join('\n');

    const { stopped, full } = both(src);

    expect(headingTag(stopped)).toEqual('h2');
    expect(headingText(stopped)).toEqual('Real Heading');
    // Stops right at the heading rather than tokenizing the rest of the page.
    expect(stopped[stopped.length - 1].type).toEqual('heading_close');
    expect(stopped.length).toBeLessThan(full.length);
  });

  it('returns exactly the prefix a full parse would produce', function () {
    const src = '```\n# fake\n```\n\n### Third Level\n\ntail paragraph\n';
    const { stopped, full } = both(src);

    expect(stopped).toEqual(full.slice(0, stopped.length));
  });

  for (const level of [2, 3, 4, 5, 6]) {
    it(`stops after an h${level}`, function () {
      const src = `${'#'.repeat(level)} Heading ${level}\n\nbody\n\n## later heading\n`;
      const { stopped, full } = both(src);

      expect(headingTag(stopped)).toEqual(`h${level}`);
      expect(headingText(stopped)).toEqual(`Heading ${level}`);
      expect(stopped[stopped.length - 1].type).toEqual('heading_close');
      expect(stopped).toEqual(full.slice(0, stopped.length));
      expect(stopped.length).toBeLessThan(full.length);
    });
  }

  it('returns the same tokens as a plain parse when there is no heading', function () {
    const src = 'Just a paragraph.\n\n- a list\n- of items\n\n> a quote\n';

    const { stopped, full } = both(src);

    expect(stopped).toEqual(full);
  });

  it('leaves output unchanged when no stopAfter is given', function () {
    const src = '# Heading\n\nbody\n\n## Another\n\nmore\n';

    expect(tokenizer.tokenize(src, {})).toEqual(tokenizer.tokenize(src));
  });
});
