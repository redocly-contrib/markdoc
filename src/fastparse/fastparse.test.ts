import { createRequire } from 'module';
import Markdoc from '../../index';
import fixtures from './fixtures/test-inputs.json';

// Published @redocly/markdoc 0.6.4: markdown-it plus Markdoc's tokenizer
// plugins. The parser is checked against it as the reference.
const reference = createRequire(__filename)('markdoc-baseline');

type Options = Record<string, any>;

function viaReference(source: string, options: Options, args?: Options) {
  const tokenizer = new reference.Tokenizer(options);
  return reference.parse(tokenizer.tokenize(source), args);
}

function outcome(fn: () => unknown) {
  try {
    return JSON.stringify(fn());
  } catch (error) {
    return `threw ${(error as Error)?.constructor?.name}`;
  }
}

const SETTINGS: Options[] = [
  {},
  { html: true, allowIndentation: true, allowComments: true },
  { allowLinkValidation: true, githubAdmonitions: false },
];

describe('parser, against the markdown-it reference', function () {
  it('parses every test input like the reference', function () {
    let compared = 0;
    for (const { source, options, args } of fixtures as {
      source: string;
      options: Options;
      args?: Options;
    }[]) {
      for (const extra of [undefined, { compact: true }, { slots: true }]) {
        const parseArgs = args || extra ? { ...args, ...extra } : undefined;
        const expected = outcome(() =>
          viaReference(source, options, parseArgs)
        );
        const actual = outcome(() =>
          Markdoc.parse(source, { ...parseArgs, ...options })
        );
        // Where 0.6.4 itself throws, the parser returns an AST instead.
        if (actual !== expected && !expected.startsWith('threw'))
          fail(`differs for ${JSON.stringify({ source, options, parseArgs })}`);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('parses edge cases under each setting like the reference', function () {
    const sources = [
      '# Title {% #t .x %}\n\nText *em* **strong** `code` ~~s~~ [l](/u "t") ![i](/i.png)\n',
      '- a\n- b\n  - c\n\n1. x\n2. y\n\n> quote\n> more\n\n---\n',
      '{% callout type="note" %}\nBody {% $v %}\n{% /callout %}\n\n{% unclosed %}\n',
      '| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```js {% .c %}\nconst x = 1; {% $y %}\n```\n',
      '---\ntitle: T\n---\n\n> [!NOTE]\n> admonition body\n\n[ref]: /url\n\nSee [ref].\n',
      '<div>\n\n*html*\n\n</div>\n\n<!-- comment -->\n\n    indented\n\n\ttabbed\n',
      '[a]: /u\n"title on the next line"\n\n[b\nc]: /x\n\n[d]: /u "unclosed\n\nSee [a], [b c], [d].\n',
    ];
    for (const options of SETTINGS)
      for (const source of sources)
        for (const args of [undefined, { compact: true }, { file: 'f.md' }])
          expect(outcome(() => Markdoc.parse(source, { ...args, ...options })))
            .withContext(JSON.stringify({ source, options, args }))
            .toEqual(outcome(() => viaReference(source, options, args)));
  });

  it('parses an unclosed inline tag in link text, where 0.6.4 throws', function () {
    const source = 'See [a {% t %}](/u) here.';
    expect(() => viaReference(source, {})).toThrowError(TypeError);
    const link = Markdoc.parse(source).children[0].children[0].children.find(
      (n: any) => n.type === 'link'
    );
    expect(link).toBeDefined();
    const errors = Markdoc.validate(Markdoc.parse(source), {});
    expect(errors.map((e) => e.error.id)).toContain('missing-opening');
  });
});

describe('link reference definitions', function () {
  it('parse in linear time (markdown-it#996)', function () {
    const definitions = (n: number) => {
      let src = '';
      for (let i = 0; i < n; i++) src += `[r${i}]: https://x.y/${i} "T ${i}"\n`;
      return src + '\nSee [r1].\n';
    };
    Markdoc.parse(definitions(2000));
    const start = Date.now();
    const ast = Markdoc.parse(definitions(20000));
    // markdown-it takes well over a minute for this; quadratic growth would too.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(JSON.stringify(ast)).toContain('"href":"https://x.y/1"');
  });
});
