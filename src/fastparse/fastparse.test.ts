import Markdoc from '../../index';

const sources = [
  '# Title {% #t .x %}\n\nText *em* **strong** `code` ~~s~~ [l](/u "t") ![i](/i.png)\n',
  '- a\n- b\n  - c\n\n1. x\n2. y\n\n> quote\n> more\n\n---\n',
  '{% callout type="note" %}\nBody {% $v %}\n{% /callout %}\n\n{% unclosed %}\n',
  '| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```js {% .c %}\nconst x = 1; {% $y %}\n```\n',
  '---\ntitle: T\n---\n\n> [!NOTE]\n> admonition body\n\n[ref]: /url\n\nSee [ref].\n',
  '<div>\n\n*html*\n\n</div>\n\n<!-- comment -->\n\n    indented\n\n\ttabbed\n',
];

const configs = [
  {},
  { html: true, allowIndentation: true, allowComments: true },
  { allowLinkValidation: true, githubAdmonitions: false },
];

describe('parse(string) fast path', function () {
  it('gives the same AST as parsing markdown-it tokens', function () {
    for (const tokenizer of configs)
      for (const source of sources)
        for (const args of [
          {},
          { compact: true },
          { slots: true, file: 'f' },
        ]) {
          const viaTokens = Markdoc.parse(
            new Markdoc.Tokenizer(tokenizer).tokenize(source),
            args
          );
          const direct = Markdoc.parse(source, { ...args, tokenizer });
          expect(JSON.stringify(direct)).toEqual(JSON.stringify(viaTokens));
        }
  });

  it('honors githubAdmonitions: false in parser args', function () {
    const source = '> [!NOTE]\n> body';
    const plain = Markdoc.parse(source, { githubAdmonitions: false });
    expect(plain.children[0].attributes.kind).toBeUndefined();
    expect(Markdoc.parse(source).children[0].attributes.kind).toEqual('note');
  });

  it('falls back to markdown-it for options the fast parser lacks', function () {
    const source = 'Visit https://example.com today';
    const ast = Markdoc.parse(source, { tokenizer: { linkify: true } });
    const viaTokens = Markdoc.parse(
      new Markdoc.Tokenizer({ linkify: true }).tokenize(source)
    );
    expect(JSON.stringify(ast)).toEqual(JSON.stringify(viaTokens));
    expect(JSON.stringify(ast)).toContain('"href":"https://example.com"');
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
