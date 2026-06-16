import Markdoc from '../../index';

function convert(src: string, args: any = {}) {
  return Markdoc.parse(src, { ...args });
}

describe('lone-tag transform', function () {
  it('unwraps a same-line tag from its implied paragraph', function () {
    const doc = convert(`{% callout %}hi{% /callout %}`, {
      noParagraphForLoneTag: true,
    });
    expect(doc.children.length).toBe(1);
    expect(doc.children[0].type).toEqual('tag');
    expect(doc.children[0].tag).toEqual('callout');
  });

  it('unwraps a same-line tag with no body content', function () {
    const doc = convert(`{% callout %}{% /callout %}`, {
      noParagraphForLoneTag: true,
    });
    expect(doc.children.length).toBe(1);
    expect(doc.children[0].type).toEqual('tag');
    expect(doc.children[0].tag).toEqual('callout');
  });

  it('does NOT unwrap when the paragraph has sibling text', function () {
    const doc = convert(`text {% mytag /%} more`, {
      noParagraphForLoneTag: true,
    });
    expect(doc.children[0].type).toEqual('paragraph');
  });

  it('does NOT unwrap when paragraph has annotations', function () {
    // Inline annotation right after the tag — no whitespace — so no trailing
    // text node; the paragraph gets `annotations` set and lone-tag should bail.
    const doc = convert(`{% callout %}hi{% /callout %}{% .red %}`, {
      noParagraphForLoneTag: true,
    });
    // The annotation attaches to the paragraph; leaving the paragraph in
    // place preserves it.
    expect(doc.children[0].type).toEqual('paragraph');
  });

  it('multi-line block tag is unchanged (already unwrapped by markdown-it)', function () {
    const doc = convert(`{% mytag %}\nhi\n{% /mytag %}`, {
      noParagraphForLoneTag: true,
    });
    expect(doc.children[0].type).toEqual('tag');
  });

  it('does not unwrap when flag is off (compat)', function () {
    // Open/close same-line tag is paragraph-wrapped; without the flag it stays.
    const doc = convert(`{% callout %}hi{% /callout %}`);
    expect(doc.children[0].type).toEqual('paragraph');
  });

  it('unwraps nested cases (inside blockquote)', function () {
    const doc = convert(`> {% callout %}hi{% /callout %}`, {
      noParagraphForLoneTag: true,
    });
    const bq = doc.children[0];
    expect(bq.type).toEqual('blockquote');
    expect(bq.children[0].type).toEqual('tag');
    expect(bq.children[0].tag).toEqual('callout');
  });
});
