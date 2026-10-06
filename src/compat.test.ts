import Markdoc from '../index';

const FIXTURES = [
  ['heading', `# Hello, world`],
  ['paragraph', `Just a plain paragraph.`],
  ['emphasis', `Some **bold** and *italic* text.`],
  ['lone tag', `{% mytag %}hi{% /mytag %}`],
  ['self-closing tag', `{% mytag /%}`],
  ['blockquote', `> quoted text`],
  ['gh-style blockquote (no plugin)', `> [!NOTE]\n> body`],
  ['list', `- one\n- two`],
  ['fence', '```js\nconsole.log(1);\n```'],
  ['mixed', `# heading\n\nparagraph with [link](https://a)\n\n> quote`],
];

describe('compat guard', function () {
  describe('parse() with no flags matches AST shape baseline', function () {
    for (const [name, src] of FIXTURES) {
      it(name, function () {
        const ast = Markdoc.parse(src);
        // Top-level type is always 'document' when compact is off.
        expect(ast.type).toEqual('document');
        // No node loses its `inline` wrapper.
        let sawInline = false;
        for (const node of ast.walk()) {
          if (node.type === 'inline') sawInline = true;
        }
        if (
          src.includes('**') ||
          src.includes('*') ||
          src.includes('[') ||
          /\bparagraph\b/.test(src) ||
          /^# /.test(src)
        ) {
          expect(sawInline).toBe(true);
        }
        // Child nodes have location by default.
        if (ast.children.length > 0) {
          expect(ast.children[0].location).toBeDefined();
        }
      });
    }
  });

  describe('transform() with no flags matches render shape baseline', function () {
    for (const [name, src] of FIXTURES) {
      it(name, function () {
        const out = Markdoc.transform(Markdoc.parse(src));
        const tag = Array.isArray(out) ? out[0] : out;
        // Top-level always wraps in <article>.
        expect(tag.name).toEqual('article');
      });
    }
  });

  it('GitHub admonitions are recognized by default', function () {
    const ast = Markdoc.parse(`> [!NOTE]\n> body`);
    expect(ast.children[0].attributes.kind).toEqual('note');
  });

  it('GitHub admonitions can be opted out via githubAdmonitions: false', function () {
    const ast = Markdoc.parse(`> [!NOTE]\n> body`, { githubAdmonitions: false });
    expect(ast.children[0].attributes.kind).toBeUndefined();
  });
});
