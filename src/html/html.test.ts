import Markdoc from '../../index';
import { htmlTags, getJsxConvertedAttributes } from '.';

function parse(source: string, args: Record<string, unknown> = {}) {
  return Markdoc.parse(source, { ...args, html: htmlTags() });
}

function tags(node: any, out: any[] = []) {
  if (node.type === 'tag') out.push([node.tag, node.attributes]);
  for (const child of node.children) tags(child, out);
  return out;
}

describe('htmlTags', function () {
  it('turns an HTML element into an html tag around its markdown', function () {
    const ast = parse('<details>\n\n**Bold** text\n\n</details>');
    const [details] = ast.children;
    expect(details.type).toEqual('tag');
    expect(details.tag).toEqual('html');
    expect(details.attributes).toEqual({ name: 'details', attrs: {} });
    expect(details.children[0].type).toEqual('paragraph');
  });

  it('converts attributes to React props', function () {
    const ast = parse(
      '<label for="x" class="c" style="font-size: 2px; --gap: 1px">L</label>'
    );
    expect(tags(ast)[0][1]).toEqual({
      name: 'label',
      attrs: {
        htmlFor: 'x',
        className: 'c',
        style: { fontSize: '2px', '--gap': '1px' },
      },
    });
    expect(
      getJsxConvertedAttributes({ value: 'v', checked: '' }, 'input')
    ).toEqual({ defaultValue: 'v', defaultChecked: true });
  });

  it('handles inline HTML within a paragraph', function () {
    const ast = parse('Some <b>bold</b> and <br> text');
    const inline = ast.children[0].children[0];
    const names = inline.children
      .filter((n: any) => n.type === 'tag')
      .map((n: any) => n.attributes.name);
    expect(names).toEqual(['b', 'br']);
    expect(inline.children.every((n: any) => n.inline)).toBe(true);
  });

  it('closes an unclosed element after an error tag', function () {
    const ast = parse('<div>\n\nopen');
    expect(tags(ast)).toEqual([
      ['html', { name: 'div', attrs: {} }],
      ['markdoc-error', { message: 'HTML element <div> is not closed' }],
    ]);
    expect(Markdoc.validate(ast, {}).map((e) => e.error.id)).not.toContain(
      'missing-closing'
    );
  });

  it('uses a custom error tag', function () {
    const ast = Markdoc.parse('<span>open', {
      html: htmlTags({ errorTag: 'oops' }),
    });
    expect(tags(ast).map(([tag]) => tag)).toEqual(['html', 'oops']);
  });

  it('keeps a tag that cannot be an element name as text', function () {
    const ast = parse('<div>\nsee <my@tag> here\n</div>');
    expect(JSON.stringify(ast)).not.toContain('"name":"my@tag"');
    expect(JSON.stringify(ast)).toContain('<my@tag>');
  });

  it('is opt-in: html: true still gives html_block and html_inline nodes', function () {
    const ast = Markdoc.parse('<div>\n\nx\n\n</div>\n\na <b>b</b>', {
      html: true,
    });
    const types: string[] = [];
    for (const node of ast.walk()) types.push(node.type);
    expect(types).toContain('html_block');
    expect(types).toContain('html_inline');
  });
});
