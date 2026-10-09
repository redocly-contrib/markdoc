import Markdoc from '../../index';
import Node from './node';

/**
 * Sources covering the shapes a stored AST actually contains. Each is checked
 * against what a compact parse produces for the same source.
 */
const SOURCES: [string, string][] = [
  ['heading with inline content', '# Head **bold** `code`\n'],
  ['paragraph with link and image', 'Para with [l](/x "t") and ![i](/y).\n'],
  ['several blocks', '# H\n\npara\n\n- a\n- b\n\n> quote\n'],
  ['fence with annotations', '```js {% .cls %}\ncode()\n```\n'],
  ['gfm table', '| a | b |\n| - | - |\n| 1 | 2 |\n'],
  ['markdoc table', '{% table %}\n- H1\n- H2\n---\n- a\n- b\n{% /table %}\n'],
  ['tag with attributes', '{% callout type="warning" #id .cls %}\nbody **b**\n{% /callout %}\n'],
  ['self-closing tag', '{% mytag a=1 b=[1,2] c={"k":"v"} /%}\n'],
  ['variable attribute', '{% callout x=$foo.bar %}\nb\n{% /callout %}\n'],
  ['function attribute', '{% callout x=equals(1,2) %}\nb\n{% /callout %}\n'],
  ['annotations on a heading', '# Head {% #my-id .cls %}\n'],
  ['frontmatter', '---\ntitle: x\n---\n\n# H\n'],
  ['github admonition', '> [!NOTE]\n> body\n'],
  ['nested list', '- a\n  - b\n    - c\n'],
  ['nested blockquote', '> # H\n>\n> - x\n'],
  ['hard and soft breaks', 'a\\\nb\nc\n'],
  ['empty document', ''],
  ['unclosed tag (produces errors)', '{% mytag %}\nbody\n'],
];

describe('Ast.compact', function () {
  describe('matches a compact parse', function () {
    for (const [label, src] of SOURCES) {
      it(label, function () {
        const compacted = Markdoc.compact(Markdoc.parse(src));
        const reference = Markdoc.parse(src, { compact: true });

        if (reference.type === 'document') {
          // Same shape all the way down, including JSON key order.
          expect(JSON.stringify(compacted)).toEqual(JSON.stringify(reference));
        } else {
          // A compact *parse* unwraps a single-child document; `compact` keeps
          // the root on purpose, so compare below it.
          expect(compacted.type).toEqual('document');
          expect(JSON.stringify(compacted.children)).toEqual(
            JSON.stringify([reference])
          );
        }
      });
    }
  });

  it('strips location from every node', function () {
    const compacted = Markdoc.compact(Markdoc.parse('# H\n\npara **b**\n'));
    for (const node of [compacted, ...compacted.walk()])
      expect(node.location).toBeUndefined();
  });

  it('removes inline wrapper nodes and keeps the inline flags', function () {
    const compacted = Markdoc.compact(Markdoc.parse('# Head **bold**\n'));
    const all = [...compacted.walk()];

    expect(all.some((n) => n.type === 'inline')).toBe(false);
    // The former inline children sit directly on the heading, still flagged.
    const heading = compacted.children[0];
    expect(heading.type).toEqual('heading');
    expect(heading.children.map((c) => c.type)).toEqual(['text', 'strong']);
    expect(heading.children.every((c) => c.inline)).toBe(true);
  });

  it('does not mutate its input', function () {
    const full = Markdoc.parse('# H **b**\n\npara\n');
    const before = JSON.stringify(full);

    const compacted = Markdoc.compact(full);

    expect(JSON.stringify(full)).toEqual(before);
    expect(compacted).not.toBe(full);
    expect(compacted.children).not.toBe(full.children);
    expect(compacted.children[0].attributes).not.toBe(
      full.children[0].attributes
    );
  });

  it('keeps errors wherever they exist', function () {
    const compacted = Markdoc.compact(Markdoc.parse('{% mytag %}\nbody\n'));
    const errors = [compacted, ...compacted.walk()].flatMap(
      (n) => n.errors ?? []
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.id)).toContain('missing-closing');
  });

  it('omits errors, annotations and slots when they are empty', function () {
    const compacted = Markdoc.compact(Markdoc.parse('para\n'));

    for (const node of [compacted, ...compacted.walk()]) {
      expect(node.errors).toBeUndefined();
      expect(node.annotations).toBeUndefined();
      expect(node.slots).toBeUndefined();
    }
  });

  it('keeps annotations when present', function () {
    const compacted = Markdoc.compact(
      Markdoc.parse('# Head {% #my-id .cls %}\n')
    );
    const annotated = [compacted, ...compacted.walk()].find(
      (n) => n.annotations?.length
    );

    expect(annotated).toBeDefined();
    expect(annotated?.annotations?.map((a) => a.name)).toContain('id');
  });

  it('compacts slots recursively', function () {
    const src =
      '{% mytag %}\n{% slot "footer" %}\n# In slot **b**\n{% /slot %}\nbody\n{% /mytag %}\n';
    const compacted = Markdoc.compact(Markdoc.parse(src, { slots: true }));
    const tag = compacted.children[0];

    expect(Object.keys(tag.slots ?? {})).toEqual(['footer']);
    const slot = tag.slots?.footer as Node;
    expect(slot).toBeDefined();
    for (const node of [slot, ...slot.walk()]) {
      expect(node.location).toBeUndefined();
      expect(node.type).not.toEqual('inline');
    }
  });

  it('keeps Variable and Function attribute values as instances', function () {
    const withVariable = Markdoc.compact(Markdoc.parse('{% c x=$foo.bar /%}\n'));
    const variable = [...withVariable.walk()].find((n) => n.tag === 'c')
      ?.attributes.x;
    expect(variable instanceof Markdoc.Ast.Variable).toBe(true);
    expect(variable.path).toEqual(['foo', 'bar']);

    const withFunction = Markdoc.compact(
      Markdoc.parse('{% c x=equals(1,2) /%}\n')
    );
    const fn = [...withFunction.walk()].find((n) => n.tag === 'c')?.attributes.x;
    expect(fn instanceof Markdoc.Ast.Function).toBe(true);
    expect(fn.name).toEqual('equals');
  });

  it('accepts and returns a Node array', function () {
    const full = Markdoc.parse('# H\n\npara **b**\n');
    const compacted = Markdoc.compact(full.children);

    expect(Array.isArray(compacted)).toBe(true);
    expect(compacted.map((n) => n.type)).toEqual(['heading', 'paragraph']);
    for (const node of compacted) expect(node.location).toBeUndefined();
  });

  it('keeps the root even when the document has a single child', function () {
    // The difference from a compact parse, which would return the child.
    const compacted = Markdoc.compact(Markdoc.parse('# Only\n'));
    expect(compacted.type).toEqual('document');
    expect(compacted.children.length).toBe(1);
  });

  it('survives a round-trip through Ast.fromJSON', function () {
    const compacted = Markdoc.compact(Markdoc.parse('# H **b**\n\npara\n'));
    const revived = Markdoc.Ast.fromJSON(JSON.stringify(compacted));

    expect(JSON.stringify(revived)).toEqual(JSON.stringify(compacted));
    expect(revived instanceof Node).toBe(true);
  });

  it('is reachable as both Markdoc.compact and Ast.compact', function () {
    expect(typeof Markdoc.compact).toEqual('function');
    expect(typeof Markdoc.Ast.compact).toEqual('function');
  });
});
