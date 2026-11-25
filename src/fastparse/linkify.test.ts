import Markdoc from '../../index';
import { htmlTags } from '../../html';

function html(source: string, linkify = true) {
  const out = Markdoc.renderers.html(
    Markdoc.transform(Markdoc.parse(source, { linkify }))
  );
  return out.replace(/^<article>/, '').replace(/<\/article>$/, '');
}

const link = (href: string, text = href) => `<a href="${href}">${text}</a>`;

describe('linkify (GitHub-flavored autolinks)', function () {
  it('is off by default', function () {
    expect(html('Visit www.example.com', false)).toEqual(
      '<p>Visit www.example.com</p>'
    );
  });

  // The examples of the GFM spec, "Autolinks (extension)".
  const examples: [string, string][] = [
    [
      'www.commonmark.org',
      link('http://www.commonmark.org', 'www.commonmark.org'),
    ],
    [
      'Visit www.commonmark.org/help for more information.',
      `Visit ${link(
        'http://www.commonmark.org/help',
        'www.commonmark.org/help'
      )} for more information.`,
    ],
    [
      'Visit www.commonmark.org.',
      `Visit ${link('http://www.commonmark.org', 'www.commonmark.org')}.`,
    ],
    [
      'Visit www.commonmark.org/a.b.',
      `Visit ${link(
        'http://www.commonmark.org/a.b',
        'www.commonmark.org/a.b'
      )}.`,
    ],
    [
      'www.google.com/search?q=Markup+(business)',
      link(
        'http://www.google.com/search?q=Markup+(business)',
        'www.google.com/search?q=Markup+(business)'
      ),
    ],
    [
      'www.google.com/search?q=Markup+(business)))',
      link(
        'http://www.google.com/search?q=Markup+(business)',
        'www.google.com/search?q=Markup+(business)'
      ) + '))',
    ],
    [
      '(www.google.com/search?q=Markup+(business))',
      `(${link(
        'http://www.google.com/search?q=Markup+(business)',
        'www.google.com/search?q=Markup+(business)'
      )})`,
    ],
    [
      '(www.google.com/search?q=Markup+(business)',
      `(${link(
        'http://www.google.com/search?q=Markup+(business)',
        'www.google.com/search?q=Markup+(business)'
      )}`,
    ],
    [
      'www.google.com/search?q=(business))+ok',
      link(
        'http://www.google.com/search?q=(business))+ok',
        'www.google.com/search?q=(business))+ok'
      ),
    ],
    [
      'www.google.com/search?q=commonmark&hl=en',
      link(
        'http://www.google.com/search?q=commonmark&amp;hl=en',
        'www.google.com/search?q=commonmark&amp;hl=en'
      ),
    ],
    [
      'www.google.com/search?q=commonmark&hl;',
      link(
        'http://www.google.com/search?q=commonmark',
        'www.google.com/search?q=commonmark'
      ) + '&amp;hl;',
    ],
    [
      'www.commonmark.org/he<lp',
      link('http://www.commonmark.org/he', 'www.commonmark.org/he') + '&lt;lp',
    ],
    ['http://commonmark.org', link('http://commonmark.org')],
    [
      '(Visit https://encrypted.google.com/search?q=Markup+(business))',
      `(Visit ${link(
        'https://encrypted.google.com/search?q=Markup+(business)'
      )})`,
    ],
    [
      'Anonymous FTP is available at ftp://foo.bar.baz.',
      `Anonymous FTP is available at ${link('ftp://foo.bar.baz')}.`,
    ],
    ['foo@bar.baz', link('mailto:foo@bar.baz', 'foo@bar.baz')],
    [
      "hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.",
      `hello@mail+xyz.example isn't valid, but ${link(
        'mailto:hello+xyz@mail.example',
        'hello+xyz@mail.example'
      )} is.`,
    ],
    ['a.b-c_d@a.b', link('mailto:a.b-c_d@a.b', 'a.b-c_d@a.b')],
    ['a.b-c_d@a.b.', link('mailto:a.b-c_d@a.b', 'a.b-c_d@a.b') + '.'],
    ['a.b-c_d@a.b-', 'a.b-c_d@a.b-'],
    ['a.b-c_d@a.b_', 'a.b-c_d@a.b_'],
  ];

  for (const [source, expected] of examples)
    it(`links ${JSON.stringify(source)}`, function () {
      expect(html(source)).toEqual(`<p>${expected}</p>`);
    });

  it('needs a word boundary before www.', function () {
    expect(html('xwww.example.com')).toEqual('<p>xwww.example.com</p>');
    expect(html('*www.example.com*')).toEqual(
      `<p><em>${link('http://www.example.com', 'www.example.com')}</em></p>`
    );
  });

  it('rejects underscores in the last two domain labels', function () {
    expect(html('www.xxx.yyy._zzz')).toEqual('<p>www.xxx.yyy._zzz</p>');
    expect(html('www._xxx.yyy.zzz')).toEqual(
      `<p>${link('http://www._xxx.yyy.zzz', 'www._xxx.yyy.zzz')}</p>`
    );
  });

  it('leaves links, link text, images and code alone', function () {
    expect(html('[www.example.com](/x)')).toEqual(
      `<p>${link('/x', 'www.example.com')}</p>`
    );
    expect(html('<https://example.com>')).toEqual(
      `<p>${link('https://example.com')}</p>`
    );
    expect(html('`https://example.com`')).toEqual(
      '<p><code>https://example.com</code></p>'
    );
    expect(html('![https://example.com](/i.png)')).toEqual(
      '<p><img src="/i.png" alt="https://example.com"></p>'
    );
  });

  it('does not change how link brackets match', function () {
    expect(html('[see https://example.com/x](/y)')).toEqual(
      `<p>${link('/y', 'see https://example.com/x')}</p>`
    );
  });

  it('takes linear time on runs of parentheses and at signs', function () {
    const start = Date.now();
    Markdoc.parse('https://example.com/' + ')'.repeat(50000), {
      linkify: true,
    });
    Markdoc.parse('a@'.repeat(50000) + '.com', { linkify: true });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('links inside Markdoc tags and table cells', function () {
    const ast = Markdoc.parse(
      '{% note %}\nsee https://example.com\n{% /note %}\n\n| a |\n|---|\n| www.example.com |',
      { linkify: true }
    );
    const hrefs: string[] = [];
    for (const node of ast.walk())
      if (node.type === 'link') hrefs.push(node.attributes.href);
    expect(hrefs).toEqual(['https://example.com', 'http://www.example.com']);
  });

  it('ends a link at a closing Markdoc tag', function () {
    const ast = Markdoc.parse(
      '{% copy %}https://example.com/v2{% /copy %} and {% copy %}see www.example.com{%/copy%}',
      { linkify: true }
    );
    const links: string[] = [];
    for (const node of ast.walk())
      if (node.type === 'link') links.push(node.attributes.href);
    expect(links).toEqual(['https://example.com/v2', 'http://www.example.com']);
    expect([...ast.walk()].flatMap((node) => node.errors)).toEqual([]);
  });

  it('does not link a URL that runs into a Markdoc variable or tag', function () {
    const render = (source: string) =>
      Markdoc.renderers.html(
        Markdoc.transform(Markdoc.parse(source, { linkify: true }), {
          variables: { v: 'v2', host: 'example.com' },
        })
      );
    expect(render('Base: https://example.com/{% $v %}/docs')).toEqual(
      '<article><p>Base: https://example.com/v2/docs</p></article>'
    );
    expect(render('https://api.{% $host %}/v1')).toEqual(
      '<article><p>https://api.example.com/v1</p></article>'
    );
    expect(render('www.example.com/{% $v %}')).toEqual(
      '<article><p>www.example.com/v2</p></article>'
    );
  });

  it('does not link inside an HTML link', function () {
    const types = (source: string) =>
      [
        ...Markdoc.parse(source, { linkify: true, html: htmlTags() }).walk(),
      ].map((node) => node.type);
    expect(
      types('<a href="https://example.com">https://example.com</a>')
    ).not.toContain('link');
    expect(
      types('<a href="mailto:a@example.com">a@example.com</a>')
    ).not.toContain('link');
    expect(
      types('<A HREF="/x">www.example.com</A> https://example.com')
    ).toContain('link');
  });
});
