import Markdoc from '../../index';
import Node from './node';

const { pack, unpack, fromJSON } = Markdoc.Ast;

function roundTrips(ast: Node | Node[]) {
  const viaJSON = fromJSON(JSON.stringify(ast));
  const viaPack = unpack(JSON.parse(JSON.stringify(pack(ast))));
  expect(JSON.stringify(viaPack)).toEqual(JSON.stringify(viaJSON));
  return viaPack;
}

describe('Ast.pack / Ast.unpack', function () {
  const source = `---
title: Example
---

# Heading {% .title #main %}

Some *emphasis*, **strong**, \`code\` and a [link](/a "Title").

- one
- two
  - nested

{% callout type="note" %}
Inside {% $user.name %} and {% if $flag %}yes{% /if %}
{% /callout %}

| a | b |
|---|---|
| 1 | 2 |

\`\`\`js {% .x %}
const a = 1;
\`\`\`

{% partial file="p.md" /%}
`;

  it('round-trips a full AST exactly like the JSON format', function () {
    roundTrips(Markdoc.parse(source));
  });

  it('round-trips a compact AST and compact()ed trees', function () {
    roundTrips(Markdoc.parse(source, { compact: true }));
    const compacted = Markdoc.compact(Markdoc.parse(source));
    roundTrips(compacted as Node);
  });

  it('round-trips errors, annotations and slots', function () {
    const ast = Markdoc.parse(
      `{% tag %}\n{% slot "x" %}hi{% /slot %}\n{% /tag %}\n\n{% unclosed %}`,
      { slots: true }
    );
    expect(JSON.stringify(ast)).toContain('"errors"');
    expect(JSON.stringify(ast)).toContain('"slots"');
    roundTrips(ast);
  });

  it('round-trips a list of nodes', function () {
    const ast = Markdoc.parse(source);
    const list = roundTrips(ast.children) as Node[];
    expect(Array.isArray(list)).toBe(true);
  });

  it('revives variables and functions as AST instances', function () {
    const ast = Markdoc.parse(`{% tag a=$x.y b=f(1, $z) /%}`);
    const tag = (unpack(pack(ast)) as Node).children[0];
    expect(tag.attributes.a).toBeInstanceOf(Markdoc.Ast.Variable);
    expect(tag.attributes.b).toBeInstanceOf(Markdoc.Ast.Function);
    expect(tag.attributes.b.parameters[1]).toBeInstanceOf(Markdoc.Ast.Variable);
  });

  it('transforms identically to the JSON format', function () {
    const ast = Markdoc.parse(source);
    const config = {
      tags: { callout: { render: 'Callout', attributes: { type: {} } } },
      variables: { user: { name: 'Ada' }, flag: true },
    };
    const viaJSON = fromJSON(JSON.stringify(ast)) as Node;
    const viaPack = unpack(pack(ast)) as Node;
    expect(Markdoc.transform(viaPack, config)).toEqual(
      Markdoc.transform(viaJSON, config)
    );
  });

  it('stores plain inline text as a bare string', function () {
    const packed = pack(Markdoc.parse('Hello', { compact: true }));
    expect(packed).toEqual(['paragraph', 'Hello']);
  });

  it('keeps hand-built attributes whose names start with $', function () {
    const node = new Node('paragraph', { $odd: 1, $t: 'x', plain: 2 });
    roundTrips(node);
    expect((unpack(pack(node)) as Node).attributes).toEqual({
      $odd: 1,
      $t: 'x',
      plain: 2,
    });
  });

  it('keeps children that are not Nodes as they are', function () {
    const node = new Node('paragraph', {}, [
      'hello' as any,
      7 as any,
      { plain: true } as any,
      new Node('text', { content: 'x' }),
    ]);
    const copy = unpack(JSON.parse(JSON.stringify(pack(node)))) as Node;
    expect(copy.children.slice(0, 3)).toEqual([
      'hello',
      7,
      { plain: true },
    ] as any);
    expect(copy.children[3].attributes).toEqual({ content: 'x' });
  });

  it('keeps a __proto__ attribute as an attribute', function () {
    const node = new Node('paragraph', JSON.parse('{"__proto__":{"x":1}}'));
    const copy = unpack(JSON.parse(JSON.stringify(pack(node)))) as Node;
    expect(Object.keys(copy.attributes)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(copy.attributes)).toBe(Object.prototype);
  });

  it('never mutates the value it unpacks', function () {
    const packed = JSON.parse(
      JSON.stringify(pack(Markdoc.parse(`{% tag a=$x %}text{% /tag %}`)))
    );
    const before = JSON.stringify(packed);
    const node = unpack(packed) as Node;
    node.children[0].attributes.extra = true;
    node.children[0].errors.push({ id: 'x', level: 'error', message: 'x' });
    expect(JSON.stringify(packed)).toEqual(before);
    expect(JSON.stringify(unpack(packed))).toEqual(
      JSON.stringify(
        fromJSON(JSON.stringify(Markdoc.parse(`{% tag a=$x %}text{% /tag %}`)))
      )
    );
  });
});

describe('Ast.pack(ast, { compact: true })', function () {
  const sources = [
    `# Title {% #t %}\n\nPara with *em* and {% $v %}.\n\n{% tag a=1 %}\nInner **b**\n{% /tag %}\n\n- [x] item`,
    `{% slotted %}\n{% slot "s" %}S *x*{% /slot %}\nbody\n{% /slotted %}`,
    `{% unclosed %}\n\ntext`,
  ];

  it('equals pack(compact(ast))', function () {
    for (const source of sources) {
      const ast = Markdoc.parse(source, { slots: true });
      expect(pack(ast, { compact: true })).toEqual(pack(Markdoc.compact(ast)));
      expect(pack(ast.children, { compact: true })).toEqual(
        pack(Markdoc.compact(ast.children))
      );
    }
  });

  it('leaves out positionless locations, like toJSON', function () {
    const node = new Node('paragraph');
    node.location = {
      start: { line: undefined as any },
      end: { line: undefined as any },
    };
    expect(pack(node)).toEqual(['paragraph']);
  });
});
