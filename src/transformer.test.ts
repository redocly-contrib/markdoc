import Markdoc from '../index';

describe('transformer compact mode', function () {
  it('elides article wrapper when document has single child (compact)', function () {
    const ast = Markdoc.parse(`# Only heading`);
    const out = Markdoc.transform(ast, { compact: true });
    // Result should be an array (or single Tag) representing the heading,
    // not an <article> Tag.
    const arr = Array.isArray(out) ? out : [out];
    expect(arr.length).toBe(1);
    expect(arr[0].name).toEqual('h1');
  });

  it('keeps article wrapper when document has multiple children (compact)', function () {
    const ast = Markdoc.parse(`# heading\n\nbody`);
    const out = Markdoc.transform(ast, { compact: true });
    const tag = Array.isArray(out) ? out[0] : out;
    expect(tag.name).toEqual('article');
  });

  it('keeps article wrapper when frontmatter is present (compact)', function () {
    const ast = Markdoc.parse(`---\nfoo: bar\n---\n# heading`);
    const out = Markdoc.transform(ast, { compact: true });
    const tag = Array.isArray(out) ? out[0] : out;
    expect(tag.name).toEqual('article');
  });

  it('elides p when paragraph wraps a single block-level tag (compact)', function () {
    const config = {
      compact: true,
      tags: { box: { render: 'div' } },
    };
    const ast = Markdoc.parse(`{% box %}inside{% /box %}`);
    const out = Markdoc.transform(ast, config);
    // The article should be elided too (document has single child),
    // leaving just the div.
    const arr = Array.isArray(out) ? out : [out];
    expect(arr.length).toBe(1);
    expect(arr[0].name).toEqual('div');
  });

  it('does not elide p when paragraph has mixed content (compact)', function () {
    const config = { compact: true, tags: { box: { render: 'div' } } };
    const ast = Markdoc.parse(`Text {% box %}inside{% /box %}`);
    const out = Markdoc.transform(ast, config);
    const arr = Array.isArray(out) ? out : [out];
    expect(arr[0].name).toEqual('p');
  });

  it('keeps article and p when compact is off (compat)', function () {
    const ast = Markdoc.parse(`# heading`);
    const out = Markdoc.transform(ast);
    const tag = Array.isArray(out) ? out[0] : out;
    expect(tag.name).toEqual('article');
  });
});
