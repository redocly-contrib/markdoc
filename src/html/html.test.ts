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

  it('makes boolean attributes true, as React drops empty strings', function () {
    expect(
      getJsxConvertedAttributes(
        { open: '', disabled: 'disabled', readonly: '', 'aria-hidden': '' },
        'details'
      )
    ).toEqual({
      open: true,
      disabled: true,
      readOnly: true,
      'aria-hidden': '',
    });
  });

  it('keeps colons and semicolons inside style values', function () {
    expect(
      getJsxConvertedAttributes({
        style:
          'background:url(https://e.com/a.png); content: "a;b"; mask: url(data:image/png;base64,AA==)',
      }).style
    ).toEqual({
      background: 'url(https://e.com/a.png)',
      content: '"a;b"',
      mask: 'url(data:image/png;base64,AA==)',
    });
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

  it('reports each unclosed element inside it, innermost first', function () {
    const ast = parse('<div><span>\nx');
    const [div] = ast.children;
    const [span, divError] = div.children;
    expect(span.attributes.name).toEqual('span');
    expect(span.children[1].attributes).toEqual({
      message: 'HTML element <span> is not closed',
    });
    expect(divError.attributes).toEqual({
      message: 'HTML element <div> is not closed',
    });
  });

  it('keeps text htmlparser2 holds back at the end of a run', function () {
    const ast = parse('<div>\n&am');
    expect(ast.children[0].children[0].attributes.content).toEqual('\n&am');
  });

  describe('an inline element not closed in its Markdown container', function () {
    function text(node: any): string {
      return node.type === 'text'
        ? node.attributes.content
        : node.children.map(text).join('');
    }
    function only(source: string, type: string) {
      const ast = parse(source);
      const errors = Markdoc.validate(ast, {})
        .map((e) => e.error.id)
        .filter((id) => id !== 'tag-undefined');
      expect(errors).withContext(source).toEqual([]);
      expect(tags(ast).map(([tag]) => tag))
        .withContext(source)
        .not.toContain('markdoc-error');
      const nodes = [...ast.walk()].filter((n: any) => n.type === type);
      expect(nodes.length).withContext(source).toEqual(1);
      return nodes[0];
    }

    it('is text in link text', function () {
      expect(text(only('[GET /users/<id>](/api/users)', 'link'))).toEqual(
        'GET /users/<id>'
      );
      expect(
        text(only('[Multiple <angle> <brackets> here](http://e.com)', 'link'))
      ).toEqual('Multiple <angle> <brackets> here');
      expect(text(only('[GET <id>](/x) and more', 'paragraph'))).toEqual(
        'GET <id> and more'
      );
    });

    it('is text in emphasis, a list item and an inline tag', function () {
      expect(text(only('**GET /users/<id>** after', 'strong'))).toEqual(
        'GET /users/<id>'
      );
      expect(text(only('*a <id>* b', 'em'))).toEqual('a <id>');
      const list = only('- [GET <id>](/x)\n- next', 'list');
      expect(list.children.map(text)).toEqual(['GET <id>', 'next']);
      expect(text(only('{% badge %}v<id>{% /badge %} x', 'tag'))).toEqual(
        'v<id>'
      );
    });

    it('is text in a paragraph, whatever its name', function () {
      for (const source of [
        'Text <id> outside a link',
        'See <template> and <title> here',
        'A <Foo /> mid',
      ])
        expect(text(only(source, 'paragraph'))).toEqual(source);
    });

    it('is text when it closes outside, or opens outside and closes inside', function () {
      expect(text(only('<span>[x</span>](/u) <id>', 'paragraph'))).toEqual(
        '<span>x</span> <id>'
      );
      expect(text(only('[<b>x](/u)</b> <id>', 'paragraph'))).toEqual(
        '<b>x</b> <id>'
      );
    });

    it('is left to htmlparser2 when the inline content closes every element', function () {
      const ast = parse('<span>[x</span>](/u)');
      expect(tags(ast)[0]).toEqual(['html', { name: 'span', attrs: {} }]);
    });

    it('leaves closed and void elements and inline code as they are', function () {
      const link = only(
        '[a <b>bold</b> <br> `code <name>` <i>x</i>](/u)',
        'link'
      );
      expect(tags(link)).toEqual([
        ['html', { name: 'b', attrs: {} }],
        ['html', { name: 'br', attrs: {} }],
        ['html', { name: 'i', attrs: {} }],
      ]);
      expect(
        link.children.find((n: any) => n.type === 'code').attributes
      ).toEqual({ content: 'code <name>' });
      expect(
        tags(parse('a <span><b>x</b></span> <img src="i.png"> b'))
      ).toEqual([
        ['html', { name: 'span', attrs: {} }],
        ['html', { name: 'b', attrs: {} }],
        ['html', { name: 'img', attrs: { src: 'i.png' } }],
      ]);
    });

    it("leaves a void element's closing tag to htmlparser2", function () {
      for (const [source, names] of [
        ['Logo <img src="i.png"></img> here', ['img']],
        [
          'A <video><source src="a.mp4"></source></video> b',
          ['video', 'source'],
        ],
        ['Line<br></br>next', ['br', 'br']],
      ] as const) {
        const paragraph = only(source, 'paragraph');
        expect(tags(paragraph).map(([, attributes]) => attributes.name))
          .withContext(source)
          .toEqual(names);
        expect(text(paragraph)).withContext(source).not.toContain('</');
      }
      expect(
        text(only('[GET <id>](/x) <img src="i.png"></img>', 'link'))
      ).toEqual('GET <id>');
    });
  });

  it('uses a custom error tag', function () {
    const ast = Markdoc.parse('<div>\n\nopen', {
      html: htmlTags({ errorTag: 'oops' }),
    });
    expect(tags(ast).map(([tag]) => tag)).toEqual(['html', 'oops']);
  });

  it('keeps a tag that cannot be an element name as text', function () {
    const ast = parse('<div>\nsee <my@tag> here\n</div>');
    expect(JSON.stringify(ast)).not.toContain('"name":"my@tag"');
    expect(JSON.stringify(ast)).toContain('<my@tag>');
  });

  it('makes block HTML headings headings with headings: true, keeping only their id', function () {
    const ast = Markdoc.parse(
      '<h2 id="fields" class="wide">Response <code>x</code></h2>\n\n<div>\n<h3>Nested</h3>\n</div>\n\nText <h4>inline</h4> more.',
      { html: htmlTags({ headings: true }) }
    );
    const [heading, div, paragraph] = ast.children;
    expect([heading.type, heading.attributes]).toEqual([
      'heading',
      { level: 2, id: 'fields' },
    ]);
    expect(heading.children[0].type).toEqual('inline');
    expect(tags(heading)).toEqual([['html', { name: 'code', attrs: {} }]]);
    expect(div.children[0].attributes).toEqual({ level: 3 });
    expect(tags(paragraph)).toEqual([['html', { name: 'h4', attrs: {} }]]);
    expect(tags(parse('<h2>x</h2>'))).toEqual([
      ['html', { name: 'h2', attrs: {} }],
    ]);
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
