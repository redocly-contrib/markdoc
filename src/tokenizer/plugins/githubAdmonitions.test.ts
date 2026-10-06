import Tokenizer from '../index';
import parser from '../../parser';
import Markdoc from '../../../index';
import { ADMONITION_KINDS } from './githubAdmonitions';

function parse(src: string, opts: any = {}) {
  // Default Tokenizer now has githubAdmonitions enabled; tests can drop
  // the explicit flag.
  const tokenizer = new Tokenizer(opts);
  return parser(tokenizer.tokenize(src));
}

function collectText(node: any): string {
  if (node.type === 'text') return node.attributes.content;
  const parts = [];
  for (const child of node.children ?? []) parts.push(collectText(child));
  return parts.join('');
}

describe('github admonitions plugin', function () {
  const kinds = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'success', 'danger'];

  for (const kind of kinds) {
    it(`recognizes [!${kind.toUpperCase()}]`, function () {
      const doc = parse(`> [!${kind.toUpperCase()}]\n> body`);
      const bq = doc.children[0];
      expect(bq.type).toEqual('blockquote');
      expect(bq.attributes.kind).toEqual(kind);
    });
  }

  it('is case-insensitive in source', function () {
    const doc = parse(`> [!Note]\n> body`);
    expect(doc.children[0].attributes.kind).toEqual('note');
  });

  it('strips the marker paragraph', function () {
    const doc = parse(`> [!NOTE]\n> body`);
    const bq = doc.children[0];
    // Only the body paragraph remains.
    expect(bq.children.length).toBe(1);
    expect(bq.children[0].type).toEqual('paragraph');
    // Body text is preserved; marker is not in the AST.
    const allText = collectText(bq);
    expect(allText).toEqual('body');
  });

  it('leaves unrelated blockquotes untouched', function () {
    const doc = parse(`> regular quote`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('leaves unknown bracket markers untouched', function () {
    const doc = parse(`> [!UNKNOWN]\n> body`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('does nothing when explicitly disabled via githubAdmonitions: false', function () {
    const tokenizer = new Tokenizer({ githubAdmonitions: false });
    const doc = parser(tokenizer.tokenize(`> [!NOTE]\n> body`));
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('handles multi-line body', function () {
    const doc = parse(`> [!WARNING]\n> first line\n> second line`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toEqual('warning');
    expect(bq.children.length).toBe(1);
    expect(bq.children[0].type).toEqual('paragraph');
    const allText = collectText(bq);
    expect(allText).toContain('first line');
    expect(allText).toContain('second line');
    expect(allText).not.toContain('[!WARNING]');
  });

  it('handles marker on its own line with no body', function () {
    const doc = parse(`> [!NOTE]`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toEqual('note');
    const allText = collectText(bq);
    expect(allText).not.toContain('[!NOTE]');
  });

  it('handles standard GitHub multi-paragraph admonition format', function () {
    const doc = parse(`> [!NOTE]\n>\n> This is the body.`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toEqual('note');
    // The marker paragraph is gone, only the body paragraph remains.
    expect(bq.children.length).toBe(1);
    expect(bq.children[0].type).toEqual('paragraph');
    const allText = collectText(bq);
    expect(allText).toEqual('This is the body.');
  });

  it('handles body with inline formatting', function () {
    const doc = parse(`> [!NOTE]\n> Has **bold** text.`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toEqual('note');
    expect(bq.children[0].type).toEqual('paragraph');
    const allText = collectText(bq);
    expect(allText).not.toContain('[!NOTE]');
    expect(allText).toEqual('Has bold text.');
  });

  it('recognizes marker inside a nested blockquote', function () {
    const doc = parse(`> > [!NOTE]\n> > body`);
    const outer = doc.children[0];
    expect(outer.type).toEqual('blockquote');
    expect(outer.attributes.kind).toBeUndefined();
    const inner = outer.children[0];
    expect(inner.type).toEqual('blockquote');
    expect(inner.attributes.kind).toEqual('note');
  });

  describe('validation', function () {
    it('accepts the kind attribute on blockquote', function () {
      const errors = Markdoc.validate(
        Markdoc.parse('> [!NOTE]\n> body\n'),
        {}
      );
      expect(errors).toEqual([]);
    });

    it('accepts every recognized kind', function () {
      for (const kind of ADMONITION_KINDS) {
        const errors = Markdoc.validate(
          Markdoc.parse(`> [!${kind.toUpperCase()}]\n> body\n`),
          {}
        );
        expect(errors).toEqual([]);
      }
    });

    it('reports an unrecognized kind set directly on the node', function () {
      // The tokenizer never produces this, but a consumer building an AST by
      // hand should still be told the value is not valid.
      const ast = Markdoc.parse('> body\n');
      ast.children[0].attributes.kind = 'nonsense';
      const errors = Markdoc.validate(ast, {});
      expect(errors.length).toBe(1);
      expect(errors[0].error.id).toEqual('attribute-value-invalid');
    });

    it('renders kind as a data attribute', function () {
      const out: any = Markdoc.transform(Markdoc.parse('> [!TIP]\n> body\n'));
      const tag = Array.isArray(out) ? out[0] : out;
      const bq = tag.children[0];
      expect(bq.name).toEqual('blockquote');
      expect(bq.attributes['data-kind']).toEqual('tip');
    });
  });

  describe('formatter round-trip', function () {
    for (const kind of ADMONITION_KINDS) {
      const upper = kind.toUpperCase();

      it(`round-trips [!${upper}] with a body`, function () {
        const src = `> [!${upper}]\n> Body text.\n`;
        expect(Markdoc.format(Markdoc.parse(src))).toEqual(src);
      });

      it(`round-trips [!${upper}] with no body`, function () {
        const src = `> [!${upper}]\n`;
        expect(Markdoc.format(Markdoc.parse(src))).toEqual(src);
      });

      it(`round-trips [!${upper}] with a multi-block body`, function () {
        const src = `> [!${upper}]\n> First para.\n>\n> - one\n> - two\n`;
        // Re-formatting the output is stable, and the kind survives.
        const once = Markdoc.format(Markdoc.parse(src));
        expect(Markdoc.format(Markdoc.parse(once))).toEqual(once);
        expect(Markdoc.parse(once).children[0].attributes.kind).toEqual(kind);
      });
    }

    it('leaves a plain blockquote unchanged', function () {
      const src = '> Just a quote.\n';
      expect(Markdoc.format(Markdoc.parse(src))).toEqual(src);
    });
  });
});
