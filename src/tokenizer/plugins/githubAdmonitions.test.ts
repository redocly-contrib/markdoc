import Tokenizer from '../index';
import parser from '../../parser';

function parse(src: string, opts: any = {}) {
  const tokenizer = new Tokenizer({ githubAdmonitions: true, ...opts });
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

  it('does nothing when plugin is off (compat)', function () {
    const tokenizer = new Tokenizer({});
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
});
