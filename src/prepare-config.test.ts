import Markdoc from '../index';

describe('prepareConfig', function () {
  const source = `{% callout type="note" %}Hi {% $name %}{% /callout %}`;
  const tags = {
    callout: {
      render: 'Callout',
      attributes: { type: { type: String } },
    },
  };

  it('transforms exactly like the unprepared config', function () {
    const ast = Markdoc.parse(source);
    const config = { tags, variables: { name: 'Ada' } };
    expect(Markdoc.transform(ast, Markdoc.prepareConfig(config))).toEqual(
      Markdoc.transform(ast, config)
    );
  });

  it('validates exactly like the unprepared config', function () {
    const ast = Markdoc.parse(`${source}\n{% missing /%}`);
    const config = { tags, variables: {} };
    expect(Markdoc.validate(ast, Markdoc.prepareConfig(config))).toEqual(
      Markdoc.validate(ast, config)
    );
  });

  it('includes the built-in tags, nodes and functions', function () {
    const prepared = Markdoc.prepareConfig({ tags });
    expect(prepared.tags?.if).toBe(Markdoc.tags.if);
    expect(prepared.tags?.callout).toBe(tags.callout);
    expect(prepared.nodes?.heading).toBe(Markdoc.nodes.heading);
    expect(prepared.functions?.equals).toBe(Markdoc.functions.equals);
  });

  it('stays prepared when spread to add per-call variables', function () {
    const prepared = Markdoc.prepareConfig({ tags });
    const ast = Markdoc.parse(source);
    const output = Markdoc.transform(ast, {
      ...prepared,
      variables: { name: 'Grace' },
    });
    expect(Markdoc.renderers.html(output)).toContain('Hi Grace');
  });

  it('merges again when tags are replaced after preparing', function () {
    const prepared = Markdoc.prepareConfig({ tags });
    const ast = Markdoc.parse(`{% other /%}`);
    const other = { other: { render: 'Other' } };
    const output = Markdoc.transform(ast, { ...prepared, tags: other });
    expect(Markdoc.renderers.html(output)).toContain('<Other>');
  });

  it('does not change the keys a schema transform sees', function () {
    const seen: string[][] = [];
    const config = {
      tags: {
        probe: {
          transform(_node: unknown, cfg: Record<string, unknown>) {
            seen.push(Object.keys(cfg).sort());
            return null;
          },
        },
      },
      variables: {},
    };
    const ast = Markdoc.parse(`{% probe /%}`);
    Markdoc.transform(ast, config);
    Markdoc.transform(ast, Markdoc.prepareConfig(config));
    expect(seen[1]).toEqual(seen[0]);
  });
});

describe('prepareConfig({ cloneAst: false })', function () {
  const config = {
    tags: { callout: { render: 'Callout', attributes: { title: {} } } },
    variables: { name: 'Ada' },
  };
  const source = `# Title\n\n{% callout title=$name %}Body {% $name %}{% /callout %}\n\nPlain *text*.`;

  it('transforms exactly like the default', function () {
    const ast = Markdoc.parse(source);
    expect(
      Markdoc.transform(ast, Markdoc.prepareConfig(config, { cloneAst: false }))
    ).toEqual(Markdoc.transform(ast, config));
  });

  it('hands unchanged nodes to schemas as-is and copies resolved ones', function () {
    const ast = Markdoc.parse(source);
    const seen: unknown[] = [];
    const probe = (render: string) => ({
      render,
      transform(node: any, cfg: any) {
        seen.push(node);
        return new Markdoc.Tag(render, {}, node.transformChildren(cfg));
      },
    });
    const prepared = Markdoc.prepareConfig(
      { ...config, nodes: { heading: probe('h1') } },
      { cloneAst: false }
    );
    Markdoc.transform(ast, prepared);
    const heading = ast.children[0];
    expect(seen[0]).toBe(heading);

    seen.length = 0;
    Markdoc.transform(ast, { ...config, nodes: { heading: probe('h1') } });
    expect(seen[0]).not.toBe(heading);
  });

  it('never resolves variables into the input AST', function () {
    const ast = Markdoc.parse(source);
    const before = JSON.stringify(ast);
    Markdoc.transform(ast, Markdoc.prepareConfig(config, { cloneAst: false }));
    expect(JSON.stringify(ast)).toEqual(before);
  });
});
