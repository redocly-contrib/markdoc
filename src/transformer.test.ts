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

describe('schema render overrides', function () {
  function render(src: string, nodes: any, config: any = {}) {
    const out: any = Markdoc.transform(Markdoc.parse(src), {
      ...config,
      nodes: { ...Markdoc.nodes, ...nodes },
    });
    return Array.isArray(out) ? out : [out];
  }

  it('honors a document render override', function () {
    const document = { ...Markdoc.nodes.document, render: 'div' };
    expect(render('hello', { document })[0].name).toEqual('div');
  });

  it('honors a document render override with multiple children', function () {
    const document = { ...Markdoc.nodes.document, render: 'section' };
    expect(render('# h\n\nbody', { document })[0].name).toEqual('section');
  });

  it('honors a paragraph render override', function () {
    const paragraph = { ...Markdoc.nodes.paragraph, render: 'span' };
    const out = render('# h\n\nbody', { paragraph });
    expect(out[0].name).toEqual('article');
    expect(out[0].children.map((c: any) => c.name)).toEqual(['h1', 'span']);
  });

  it('honors a document render override in compact mode when not elided', function () {
    // Two children, so compact does not elide the wrapper and `render` applies.
    const document = { ...Markdoc.nodes.document, render: 'div' };
    expect(
      render('# h\n\nbody', { document }, { compact: true })[0].name
    ).toEqual('div');
  });

  it('still elides a single-child document in compact mode despite an override', function () {
    // Compact's whole purpose is to drop the wrapper, so there is nothing for
    // `render` to apply to here.
    const document = { ...Markdoc.nodes.document, render: 'div' };
    const out = render('hello', { document }, { compact: true });
    expect(out.length).toBe(1);
    expect(out[0].name).toEqual('p');
  });

  it('lets a custom transform win over compact elision', function () {
    const document = {
      ...Markdoc.nodes.document,
      transform: () => new Markdoc.Tag('custom', {}, []),
    };
    expect(
      render('hello', { document }, { compact: true })[0].name
    ).toEqual('custom');
  });
});
