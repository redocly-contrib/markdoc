import Tokenizer from './index';

import type Token from 'markdown-it/lib/token';

const tokenizer = new Tokenizer({ html: true, allowComments: true });

const heading = () => (t: Token) => t.type === 'heading_close';

/** Stateful: ignores headings inside a `{% slot %}`. Exercises the requirement
 *  that each prefix attempt gets a fresh predicate. */
const slotAwareHeading = () => {
  let depth = 0;
  return (t: Token) => {
    if ((t as unknown as { meta?: { tag?: string } }).meta?.tag === 'slot')
      depth += t.nesting;
    return t.type === 'heading_close' && depth === 0;
  };
};

/** Long enough to force the prefix to grow past the first attempt. */
const FILLER = 'Filler paragraph with **bold** and a [link](/x).\n\n'.repeat(400);

/**
 * `tokenizeUntil` must return exactly what `tokenize(src, { stopAfter })`
 * returns, up to and including the matched token.
 */
function expectEquivalent(
  src: string,
  create: () => (t: Token) => boolean = heading
) {
  const reference = tokenizer.tokenize(src, { stopAfter: create() });
  const actual = tokenizer.tokenizeUntil(src, create);

  const referenceIndex = reference.findIndex(create());
  const actualIndex = actual.findIndex(create());
  expect(actualIndex).toEqual(referenceIndex);

  const keep = referenceIndex === -1 ? reference.length : referenceIndex + 1;
  expect(actual.slice(0, keep)).toEqual(reference.slice(0, keep));

  return actual;
}

describe('tokenizeUntil', function () {
  it('finds a heading on the first line of a long document', function () {
    const tokens = expectEquivalent('# Title\n\n' + FILLER);
    expect(tokens[tokens.length - 1].type).toEqual('heading_close');
  });

  it('ignores `#` lines inside a fenced code block', function () {
    const tokens = expectEquivalent(
      '```js\n# fake\n# also fake\n```\n\n## Real\n\n' + FILLER
    );
    expect(tokens.find((t) => t.type === 'heading_open')?.tag).toEqual('h2');
  });

  it('finds nothing when an unclosed fence swallows the document', function () {
    const tokens = expectEquivalent('```js\n# fake\n' + FILLER);
    expect(tokens.some((t) => t.type === 'heading_close')).toBe(false);
  });

  it('ignores a `#` line inside an HTML comment', function () {
    expectEquivalent('<!--\n# hidden\n-->\n\n# Real\n\n' + FILLER);
  });

  it('ignores a `#` line inside an unclosed HTML comment', function () {
    expectEquivalent('<!--\n# hidden\n' + FILLER);
  });

  it('ignores a `#` line inside an HTML block', function () {
    expectEquivalent('<div>\n# not a heading\n</div>\n\n# Real\n\n' + FILLER);
  });

  it('ignores `#` comment lines inside frontmatter', function () {
    // The hazard case: cut inside frontmatter and its `#` lines become real
    // headings, far enough before the cut that no distance check would notice.
    const tokens = expectEquivalent(
      '---\n# yaml comment\ntitle: x\n# another\n---\n\n# Real\n\n' + FILLER
    );
    const open = tokens.findIndex((t) => t.type === 'heading_open');
    expect(tokens[open + 1].content).toEqual('Real');
  });

  it('matches the full-parse result for unclosed frontmatter', function () {
    expectEquivalent('---\n# yaml comment\ntitle: x\n' + FILLER);
  });

  it('handles a heading inside a block tag', function () {
    expectEquivalent('{% callout %}\n# Inside\n{% /callout %}\n\n' + FILLER);
  });

  it('handles a multi-line tag opening', function () {
    expectEquivalent(
      '{% callout\n  a=1\n  b=2\n%}\n# Inside\n{% /callout %}\n\n' + FILLER
    );
  });

  it('handles a `#` line inside a multi-line tag opening', function () {
    // Cut inside the opening and the annotations rule fails, which would turn
    // this attribute line into a heading.
    expectEquivalent(
      '{% callout\n# weird="x"\n%}\nbody\n{% /callout %}\n\n# Real\n\n' + FILLER
    );
  });

  it('handles an unclosed tag opening', function () {
    expectEquivalent('{% callout\n  a=1\n' + FILLER);
  });

  it('handles a heading after a list', function () {
    expectEquivalent('- one\n- two\n\n# Real\n\n' + FILLER);
  });

  it('handles a heading inside a blockquote', function () {
    expectEquivalent('> # Quoted\n\n# Real\n\n' + FILLER);
  });

  it('supports a stateful predicate that skips headings inside a slot', function () {
    const src =
      '{% slot "x" %}\n# Slot heading\n{% /slot %}\n\n# Real\n\n' + FILLER;
    const tokens = expectEquivalent(src, slotAwareHeading);
    // Both headings are tokenized, but the match is the one outside the slot.
    const headings = tokens
      .filter((t) => t.type === 'inline')
      .map((t) => t.content);
    expect(headings).toContain('Slot heading');
    const matched = tokens.findIndex(slotAwareHeading());
    expect(tokens[matched - 1].content).toEqual('Real');
  });

  it('handles a heading on the last line', function () {
    expectEquivalent(FILLER + '\n# Last\n');
  });

  it('handles a document with no heading at all', function () {
    const tokens = expectEquivalent(FILLER);
    expect(tokens.some((t) => t.type === 'heading_close')).toBe(false);
  });

  it('handles an empty document', function () {
    expectEquivalent('');
  });

  it('handles a heading partway through a document', function () {
    expectEquivalent(FILLER.slice(0, 8000) + '\n# Deep\n\n' + FILLER);
  });

  describe('cost', function () {
    /** Deterministic proxy for work done: total characters handed to the
     *  underlying markdown-it parser across all attempts. */
    function charsTokenized(src: string, create = heading) {
      const probe = new Tokenizer({ html: true, allowComments: true });
      const inner = (
        probe as unknown as {
          parser: { parse: (text: string, env: unknown) => Token[] };
        }
      ).parser;
      const original = inner.parse.bind(inner);
      let total = 0;
      inner.parse = (text: string, env: unknown) => {
        total += text.length;
        return original(text, env);
      };
      probe.tokenizeUntil(src, create);
      return total;
    }

    function docWithHeadingFirst(bytes: number) {
      let s = '# Title\n\n';
      while (s.length < bytes) s += 'Some filler paragraph text here.\n\n';
      return s;
    }

    it('does not grow with document length when the heading is on line 1', function () {
      const small = charsTokenized(docWithHeadingFirst(20 * 1024));
      const large = charsTokenized(docWithHeadingFirst(570 * 1024));

      // Both should settle on the first prefix attempt.
      expect(large).toEqual(small);
      expect(large).toBeLessThan(4096);
    });

    it('reads far less than the document to find an early heading', function () {
      const src = docWithHeadingFirst(570 * 1024);
      expect(charsTokenized(src)).toBeLessThan(src.length / 100);
    });

    it('reads the whole document at most a bounded number of times when there is no match', function () {
      const src = 'Filler paragraph.\n\n'.repeat(30000);
      // Prefix attempts are capped, so total work stays close to one pass
      // rather than compounding.
      expect(charsTokenized(src)).toBeLessThan(src.length * 1.5);
    });
  });
});
