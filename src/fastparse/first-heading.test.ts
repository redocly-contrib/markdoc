import Markdoc from '../../index';
import { htmlTags } from '../html';

const OPTIONS = {
  html: true,
  allowIndentation: true,
  allowComments: true,
  slots: true,
};

function viaFullParse(source: string, args: any = OPTIONS) {
  return Markdoc.findFirstHeading(Markdoc.parse(source, args), args.skip);
}

function check(source: string, args: any = OPTIONS) {
  const expected = viaFullParse(source, args);
  expect(JSON.stringify(Markdoc.parseFirstHeading(source, args)))
    .withContext(JSON.stringify(source))
    .toEqual(JSON.stringify(expected));
  return expected;
}

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i} with *text*.\n`).join(
    '\n'
  );

describe('parseFirstHeading', function () {
  it('returns the first heading as the full parse has it', function () {
    const heading = check('Intro\n\n## Hello *world* {% #id %}\n\n# Later');
    expect(heading?.attributes).toEqual({ level: 2, id: 'id' });
  });

  it('returns undefined without a heading', function () {
    expect(Markdoc.parseFirstHeading('No heading\n\n- here', OPTIONS)).toBe(
      undefined
    );
    expect(check(filler(400))).toBe(undefined);
  });

  it('finds headings inside containers and tags', function () {
    check('> ## In a quote');
    check('- item\n  # In a list');
    check('{% section %}\n# In a tag\n{% /section %}');
  });

  it('skips tags the predicate rejects, and slots', function () {
    const skip = (tag: any) =>
      tag.tag === 'prompt' || tag.attributes.audience === 'agents';
    const source =
      '{% prompt %}\n# Not this\n{% /prompt %}\n\n{% only audience="agents" %}\n# Nor this\n{% /only %}\n\n{% card %}\n{% slot "title" %}\n# Nor a slot\n{% /slot %}\n{% /card %}\n\n# This one';
    expect(check(source, { ...OPTIONS, skip })?.children[0]).toBeDefined();
    expect(
      JSON.stringify(Markdoc.parseFirstHeading(source, { ...OPTIONS, skip }))
    ).toContain('This one');
  });

  it('agrees on lines that only look like headings', function () {
    check('# a | b\n|---|---|\n| 1 | 2 |\n\n# real'); // a table header
    check('{%\n  tag\n# not a heading\n%}\n\n# real'); // inside a multi-line tag
    check('<!-- \n# not a heading\n-->\n\n# real'); // inside a comment
    check('```\n# not a heading\n```\n\n# real'); // inside a fence
    check('---\n# yaml comment\ntitle: x\n---\n\n# real'); // in frontmatter
    check('---\n# yaml comment\ntitle: x\n---\n\n# real', {
      ...OPTIONS,
      frontmatter: false,
    });
  });

  it('works past the first windows of a long document', function () {
    check(filler(300) + '\n# deep heading\n' + filler(10));
    check('---\n' + 'k: v\n'.repeat(2000) + '# comment\n---\n\n# real');
    check('{%\n' + 'x\n'.repeat(3000) + '%}\n\n# after a long tag');
    check('<!--\n' + 'x\n'.repeat(3000) + '-->\n\n# after a long comment');
    check('{% unclosed\n\n# heading after an unclosed tag');
  });

  it('resolves link references defined after the heading', function () {
    const heading = check(
      '# See [docs] and [x][]\n\n' + filler(50) + '\n[docs]: /docs\n[x]: /x'
    );
    expect(JSON.stringify(heading)).toContain('"href":"/docs"');
  });

  it('matches the full parse on every heading-ish case under several settings', function () {
    const sources = [
      '# Title',
      '\n\n   # Indented',
      'Para\n# Interrupts',
      '#NotAHeading\n\n# Heading',
      '####### Seven\n\n###### Six',
      '* * *\n# after hr',
      '1. # in ordered list',
      '> > # nested quote',
      '| t |\n|---|\n# after table',
      '<div>\n\n# in html\n\n</div>',
      '{% if $x %}\n# conditional\n{% /if %}',
      '{% tabs %}{% tab %}# inline-ish{% /tab %}{% /tabs %}\n\n# block',
    ];
    for (const args of [
      OPTIONS,
      {},
      { ...OPTIONS, slots: false },
      { ...OPTIONS, compact: true },
      { ...OPTIONS, linkify: true },
    ])
      for (const source of sources) check(source, args);
  });
});

describe('parseFirstHeading with tags Markdoc leaves open', function () {
  const skip = (tag: any) => tag.tag === 'prompt';
  const args = { ...OPTIONS, skip };

  it('sees a tag left open inside a fence', function () {
    // Leaving the fence pops one node; with two tags left open, the outer
    // {% prompt %} still holds every later block.
    check('```\n{% prompt %}\n```\n\n# after one', args);
    expect(
      check('```\n{% prompt %}\n{% prompt %}\n```\n\n# inside', args)
    ).toBe(undefined);
  });

  it('sees a tag left open inside a paragraph', function () {
    check('Text {% prompt %} more\n\n# after', args);
  });

  it('sees a tag that a list item cannot close', function () {
    expect(
      check('{% prompt %}\n- item\n\n  {% /prompt %}\n\n# still inside', args)
    ).toBe(undefined);
  });

  it('sees an HTML element left open', function () {
    const withHtml = {
      ...OPTIONS,
      html: htmlTags(),
      skip: (tag: any) => tag.tag === 'html',
    };
    expect(check('<div>\n\nopen\n\n# inside the div', withHtml)).toBe(
      undefined
    );
  });
});

describe('frontmatter option', function () {
  it('is on by default and can be turned off', function () {
    const source = '---\ntitle: x\n---\n\n# Title';
    expect(Markdoc.parse(source).attributes.frontmatter).toEqual('title: x');
    const off = Markdoc.parse(source, { frontmatter: false });
    expect(off.attributes.frontmatter).toBeUndefined();
    expect(off.children[0].type).toEqual('hr');
  });
});
