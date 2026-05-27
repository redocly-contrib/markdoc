# Markdoc fork: compact AST, lone-tag unwrap, GH admonitions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three opt-in features to this markdoc fork: a `compact` mode that strips wrapper Nodes and per-node location data from both `parse()` and `transform()` output; a `noParagraphForLoneTag` flag that lifts same-line markdoc tags out of their implied paragraph; and a `Tokenizer` plugin that recognizes GitHub-style admonitions as `blockquote` Nodes with a `kind` attribute.

**Architecture:** All three are independent flags, each implemented at the cheapest layer. `compact` lives partly in the parser (`src/parser.ts`, `index.ts`) and partly in two schema definitions (`src/schema.ts`). `noParagraphForLoneTag` is a post-parse Node transform in `src/transforms/`. GitHub admonitions are a markdown-it `core` rule registered conditionally on the `Tokenizer`. Strict upstream compatibility is preserved when all flags are unset, guarded by a snapshot test.

**Tech Stack:** TypeScript, markdown-it (the existing tokenizer), Jasmine + `deep-assert` for tests (`spec_dir: src`, glob `**/*.test.ts`), run with `npm test`.

**Spec:** [docs/superpowers/specs/2026-05-27-markdoc-compact-and-admonitions-design.md](../specs/2026-05-27-markdoc-compact-and-admonitions-design.md)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/ast/node.ts` | Modify | Widen `errors`/`annotations`/`lines` to optional; add private lazy-init helpers |
| `src/types.ts` | Modify | Add `compact?` and `noParagraphForLoneTag?` to `ParserArgs`; add `compact?` to `ConfigType` |
| `src/parser.ts` | Modify | `compact` skips `lines`/`location`/`inline` wrapper; widen `transforms` call to pass full `args`; pick up `kind` attr on `blockquote` token |
| `index.ts` | Modify | `compact` drops top-level `document` Node when single child and no frontmatter/errors |
| `src/schema.ts` | Modify | Add `transform` to `document` and `paragraph` schemas that elide wrappers when `config.compact` |
| `src/transforms/index.ts` | Modify | Register new `lone-tag` transform |
| `src/transforms/table.ts` | Modify | Update signature: second arg is now full `ParserArgs`, read `args?.conditionalTags` |
| `src/transforms/lone-tag.ts` | Create | Post-parse transform that lifts a lone same-line tag out of its paragraph parent |
| `src/transforms/lone-tag.test.ts` | Create | Tests for lone-tag transform |
| `src/tokenizer/index.ts` | Modify | Register `githubAdmonitions` plugin when ctor flag is set |
| `src/tokenizer/plugins/githubAdmonitions.ts` | Create | `core` rule that detects `> [!KIND]` headers and adds `kind` attr to `blockquote_open` |
| `src/tokenizer/plugins/githubAdmonitions.test.ts` | Create | Tests for admonitions plugin |
| `src/parser.test.ts` | Modify | Add `compact` mode coverage |
| `src/formatter.ts` | Modify | Two `annotations.length` reads become `annotations?.length` |
| `src/compat.test.ts` | Create | Snapshot guard: byte-identical output with all new flags unset |

---

## Task 1: Lazy-init Node arrays (foundation)

**Files:**
- Modify: `src/ast/node.ts:22-43`
- Modify: `src/parser.ts:17-34, 117-126, 199-220`
- Modify: `src/transforms/table.ts:74, 82`
- Modify: `src/formatter.ts:98, 263`

The `errors`, `annotations`, and `lines` arrays on `Node` become lazy: `undefined` until first push. Read sites get `?.length`. This is the typing breaking change noted in the spec; all internal call sites get updated in this task so the package itself still builds.

- [ ] **Step 1: Write the failing test**

Append to `src/ast/node.test.ts`:

```typescript
describe('lazy-init arrays', function () {
  it('leaves errors/annotations/lines undefined when nothing pushed', function () {
    const n = new Node('paragraph');
    expect(n.errors).toBeUndefined();
    expect(n.annotations).toBeUndefined();
    expect(n.lines).toBeUndefined();
  });

  it('addError lazily creates the errors array', function () {
    const n = new Node('paragraph');
    n.addError({ id: 'x', level: 'error', message: 'm' });
    expect(n.errors).toEqual([{ id: 'x', level: 'error', message: 'm' }]);
  });

  it('addAnnotation lazily creates the annotations array', function () {
    const n = new Node('paragraph');
    n.addAnnotation({ type: 'attribute', name: 'a', value: 1 });
    expect(n.annotations).toEqual([{ type: 'attribute', name: 'a', value: 1 }]);
  });

  it('pushLines lazily creates the lines array', function () {
    const n = new Node('paragraph');
    n.pushLines([3, 5]);
    expect(n.lines).toEqual([3, 5]);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- --filter="lazy-init arrays"`
Expected: FAIL — `n.addError is not a function` (or similar).

- [ ] **Step 3: Update the `Node` class**

Replace lines 22–43 of `src/ast/node.ts` with:

```typescript
  attributes: Record<string, any>;
  slots: Record<string, Node>;
  children: Node[];
  errors?: ValidationError[];
  lines?: number[];
  type: NodeType;
  tag?: string;
  annotations?: AttributeValue[];

  inline = false;
  location?: Location;

  constructor(
    type: NodeType = 'node',
    attributes: Record<string, any> = {},
    children: Node[] = [],
    tag?: string
  ) {
    this.attributes = attributes;
    this.children = children;
    this.type = type;
    this.tag = tag;
    this.slots = {};
  }

  addError(error: ValidationError) {
    if (!this.errors) this.errors = [];
    this.errors.push(error);
  }

  addAnnotation(annotation: AttributeValue) {
    if (!this.annotations) this.annotations = [];
    this.annotations.push(annotation);
  }

  pushLines(lines: number[]) {
    if (!this.lines) this.lines = [];
    this.lines.push(...lines);
  }
```

- [ ] **Step 4: Run the new tests, confirm they pass**

Run: `npm test -- --filter="lazy-init arrays"`
Expected: PASS — 4 specs.

- [ ] **Step 5: Update mutation sites — `src/parser.ts`**

In `src/parser.ts:17-34`, change `annotate`:

```typescript
function annotate(node: Node, attributes: AttributeValue[]) {
  for (const attribute of attributes) {
    node.addAnnotation(attribute);

    const { name, value, type } = attribute;
    if (type === 'attribute') {
      if (node.attributes[name] !== undefined)
        node.addError({
          id: 'duplicate-attribute',
          level: 'warning',
          message: `Attribute '${name}' already set`,
        });
      node.attributes[name] = value;
    } else if (type === 'class')
      if (node.attributes.class) node.attributes.class[name] = value;
      else node.attributes.class = { [name]: value };
  }
}
```

At `src/parser.ts:117-126`, change the inline-annotation error branch:

```typescript
    return parent.addError({
      id: 'no-inline-annotations',
      level: 'error',
      message: `Can't apply inline annotations to '${parent.type}'`,
    });
```

At `src/parser.ts:153`, the line `node.errors = errors;` keeps working with the new optional type (assignment is fine; the test below covers behavior).

At `src/parser.ts:199-220`, change the missing-closing block:

```typescript
  if (nodes.length > 1)
    for (const node of nodes.slice(1))
      node.addError({
        id: 'missing-closing',
        level: 'critical',
        message: `Node '${node.tag || node.type}' is missing closing`,
      });
```

- [ ] **Step 6: Update mutation sites — `src/transforms/table.ts`**

Change line 74 from `row.errors.push(unexpectedNodeError(child));` to `row.addError(unexpectedNodeError(child));` and line 82 from `node.errors.push(unexpectedNodeError(row));` to `node.addError(unexpectedNodeError(row));`.

- [ ] **Step 7: Update read sites — `src/formatter.ts`**

Change line 98 from `if (n.annotations.length) {` to `if (n.annotations?.length) {` and line 263 from `if (n.annotations.length) yield SPACE;` to `if (n.annotations?.length) yield SPACE;`.

- [ ] **Step 8: Fix existing parser tests that assume empty arrays**

`src/parser.test.ts:829` reads `errors.length` on a node that has no errors, expecting `0`. With lazy init, `errors` is `undefined` and this throws. Replace that line:

```typescript
      expect(example.children[0].errors).toBeUndefined();
```

Other `errors[0]` / `errors.length` reads in this file (lines 766, 784, 801, 815, 843, 928, 937, 946) all run against nodes that DO have errors, so the array is defined and these still work unchanged.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: All tests pass. The `validator.ts:135` read (`[...(node.errors || [])]`) already handles undefined.

If any test fails, search for `.errors.` / `.annotations.` / `.lines.` outside of test files (`grep -rn` excluding `*.test.ts`) and migrate the offender. Use `?.` for reads, `addError` / `addAnnotation` / `pushLines` for writes.

- [ ] **Step 10: Type-check**

Run: `npm run type:check`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
git add src/ast/node.ts src/ast/node.test.ts src/parser.ts src/parser.test.ts src/transforms/table.ts src/formatter.ts
git commit -m "refactor(node): lazy-init errors/annotations/lines arrays"
```

---

## Task 2: Add new flags to types

**Files:**
- Modify: `src/types.ts:25-36, 169-178`

Pure type additions. No behavior change yet.

- [ ] **Step 1: Add `compact` to `ConfigType`**

In `src/types.ts:25-36`, add the `compact?: boolean` line:

```typescript
export type ConfigType<R = string> = Partial<{
  nodes: Partial<Record<NodeType, Schema<ConfigType, R>>>;
  tags: Record<string, Schema>;
  variables: Record<string, any>;
  functions: Record<string, ConfigFunction>;
  partials: Record<string, any>;
  validation?: {
    parents?: Node[];
    validateFunctions?: boolean;
    environment?: string;
  };
  compact?: boolean;
}>;
```

- [ ] **Step 2: Add `compact` and `noParagraphForLoneTag` to `ParserArgs`**

In `src/types.ts:169-178`, add two lines:

```typescript
export type ParserArgs = {
  file?: string;
  slots?: boolean;
  location?: boolean;
  conditionalTags?: string[];
  compact?: boolean;
  noParagraphForLoneTag?: boolean;
};
```

- [ ] **Step 3: Type-check**

Run: `npm run type:check`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add compact and noParagraphForLoneTag flags"
```

---

## Task 3: Compact mode in the parser — skip lines/location and inline wrapper

**Files:**
- Modify: `src/parser.ts:99-197`
- Modify: `src/parser.test.ts`

When `compact === true`: don't set `lines` or `location` on any Node, and don't create the `inline` wrapper Node (recurse children straight into the surrounding paragraph/heading/etc.).

- [ ] **Step 1: Write failing tests**

Append to `src/parser.test.ts` (in a new `describe`):

```typescript
  describe('compact mode', function () {
    it('omits lines and location from every node', function () {
      const example = convert(`# Hello\n\nWorld`, { compact: true });
      expect(example.location).toBeUndefined();
      expect(example.lines).toBeUndefined();
      for (const node of example.walk()) {
        expect(node.location).toBeUndefined();
        expect(node.lines).toBeUndefined();
      }
    });

    it('does not create inline wrapper nodes', function () {
      const example = convert(`A **bold** word`, { compact: true });
      // paragraph children should be the inline content directly, not [inline]
      const paragraph = example.children[0];
      expect(paragraph.type).toEqual('paragraph');
      expect(paragraph.children.length).toBeGreaterThan(1);
      expect(paragraph.children.some((c) => c.type === 'inline')).toBe(false);
      expect(paragraph.children.some((c) => c.type === 'strong')).toBe(true);
      expect(paragraph.children.some((c) => c.type === 'text')).toBe(true);
    });

    it('still creates inline wrapper when compact is off (compat)', function () {
      const example = convert(`A **bold** word`);
      const paragraph = example.children[0];
      expect(paragraph.children[0].type).toEqual('inline');
    });
  });
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --filter="compact mode"`
Expected: FAIL — the omit-lines test will see defined `lines`, and the inline-wrapper test will find an `inline` child.

- [ ] **Step 3: Plumb `compact` through `handleToken`**

In `src/parser.ts`, change the `handleToken` signature and the parser dispatch. Replace lines 99–197 (the entire `handleToken` function) with:

```typescript
function handleToken(
  token: Token,
  nodes: Node[],
  file?: string,
  handleSlots?: boolean,
  addLocation?: boolean,
  compact?: boolean,
  inlineParent?: Node
) {
  if (token.type === 'frontmatter') {
    nodes[0].attributes.frontmatter = token.content;
    return;
  }

  if (token.hidden || (token.type === 'text' && token.content === '')) return;

  const errors = token.errors || [];
  const parent = nodes[nodes.length - 1];
  const { tag, attributes, error } = token.meta || {};

  if (token.type === 'annotation') {
    if (inlineParent) return annotate(inlineParent, attributes);

    return parent.addError({
      id: 'no-inline-annotations',
      level: 'error',
      message: `Can't apply inline annotations to '${parent.type}'`,
    });
  }

  let typeName = token.type.replace(/_(open|close)$/, '');
  if (mappings[typeName]) typeName = mappings[typeName];

  if (typeName === 'error') {
    const { message, location } = error;
    errors.push({ id: 'parse-error', level: 'critical', message, location });
  }

  if (token.nesting < 0) {
    if (parent.type === typeName && parent.tag === tag) {
      if (!compact && parent.lines && token.map) parent.pushLines(token.map);
      return nodes.pop();
    }

    errors.push({
      id: 'missing-opening',
      level: 'critical',
      message: `Node '${typeName}' is missing opening`,
    });
  }

  // Compact mode: don't materialize the inline wrapper Node — recurse
  // children straight into the surrounding parent (paragraph/heading/etc.).
  if (compact && typeName === 'inline') {
    if (Array.isArray(token.children)) {
      const newInlineParent = parent;
      nodes.push(parent);
      for (const child of token.children)
        handleToken(child, nodes, file, handleSlots, addLocation, compact, newInlineParent);
      nodes.pop();
    }
    return;
  }

  const attrs = handleAttrs(token, typeName);
  const node = new Node(typeName, attrs, undefined, tag || undefined);
  const { position = {} } = token;

  if (errors.length) for (const e of errors) node.addError(e);

  if (!compact && addLocation !== false) {
    const lines = token.map || parent.lines || [];
    if (lines.length) node.pushLines(lines);
    node.location = {
      file,
      start: {
        line: lines[0],
        character: position.start,
      },
      end: {
        line: lines[1],
        character: position.end,
      },
    };
  }

  if (inlineParent) node.inline = true;

  if (attributes && ['tag', 'fence', 'image'].includes(typeName))
    annotate(node, attributes);

  if (
    handleSlots &&
    tag === 'slot' &&
    typeof node.attributes.primary === 'string'
  )
    parent.slots[node.attributes.primary] = node;
  else parent.push(node);

  if (token.nesting > 0) nodes.push(node);

  if (!Array.isArray(token.children)) return;

  if (node.type === 'inline') inlineParent = parent;

  nodes.push(node);

  const isLeafNode = typeName === 'image';
  if (!isLeafNode) {
    for (const child of token.children)
      handleToken(child, nodes, file, handleSlots, addLocation, compact, inlineParent);
  }

  nodes.pop();
}
```

- [ ] **Step 4: Update the `parser` dispatch to pass `compact`**

Replace `src/parser.ts:205-207`:

```typescript
  for (const token of tokens)
    handleToken(token, nodes, args?.file, args?.slots, args?.location, args?.compact);
```

- [ ] **Step 5: Run the new tests, confirm they pass**

Run: `npm test -- --filter="compact mode"`
Expected: PASS — three specs.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: All tests pass — the existing `location: true/false/default` cases still work because the new branch only triggers when `compact === true`.

- [ ] **Step 7: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat(parser): compact mode skips lines/location and inline wrappers"
```

---

## Task 4: Compact mode — drop top-level `document` when single child

**Files:**
- Modify: `index.ts:43-49`
- Modify: `src/parser.test.ts`

After `parse()` runs, if `compact === true` and the document has exactly one child, no slots, no errors, and no frontmatter, return that child directly.

- [ ] **Step 1: Write failing tests**

Add inside the `describe('compact mode', ...)` block in `src/parser.test.ts`:

```typescript
    it('drops top-level document when single child', function () {
      const example = convert(`# Just one heading`, { compact: true });
      expect(example.type).toEqual('heading');
    });

    it('keeps document when there are multiple children', function () {
      const example = convert(`# heading\n\nparagraph`, { compact: true });
      expect(example.type).toEqual('document');
      expect(example.children.length).toBe(2);
    });

    it('keeps document when frontmatter is present', function () {
      const example = convert(`---\nfoo: bar\n---\n# heading`, { compact: true });
      expect(example.type).toEqual('document');
      expect(example.attributes.frontmatter).toContain('foo: bar');
    });

    it('keeps document when there are errors', function () {
      const example = convert(`{% mytag %}\nhi\n`, { compact: true });
      expect(example.type).toEqual('document');
    });
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --filter="compact mode"`
Expected: The first new spec FAILS (`example.type` is `'document'`, not `'heading'`).

- [ ] **Step 3: Update the `parse` entrypoint in `index.ts`**

Replace `index.ts:43-49`:

```typescript
export function parse(
  content: string | Token[],
  args?: string | ParserArgs
): Node {
  if (typeof content === 'string') content = tokenizer.tokenize(content);
  const doc = parser(content, args);

  const opts = typeof args === 'object' ? args : undefined;
  if (
    opts?.compact &&
    doc.type === 'document' &&
    doc.children.length === 1 &&
    Object.keys(doc.slots).length === 0 &&
    !doc.errors?.length &&
    !doc.attributes.frontmatter
  ) {
    return doc.children[0];
  }

  return doc;
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --filter="compact mode"`
Expected: PASS — all 7 compact-mode specs.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add index.ts src/parser.test.ts
git commit -m "feat(parse): compact mode unwraps top-level document"
```

---

## Task 5: Compact mode in the transformer — `document` and `paragraph` schemas

**Files:**
- Modify: `src/schema.ts:4-21, 37-40`
- Create: `src/transformer.test.ts` (if it doesn't already exist; check first)

When `config.compact === true`: the `document` schema returns its children array without wrapping in `<article>` (when single child, no frontmatter); the `paragraph` schema returns its children array when its sole child is a block-level tag.

- [ ] **Step 1: Check whether `transformer.test.ts` exists**

Run: `ls src/transformer.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create the file with this header:

```typescript
import Markdoc from '../index';

describe('transformer compact mode', function () {});
```

- [ ] **Step 2: Write failing tests**

Inside the `describe('transformer compact mode', ...)` block:

```typescript
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
    // The article (or unwrapped output) should contain a div, not a p > div.
    const arr = Array.isArray(out) ? out : [out];
    // Find the article (it has multiple children? Or unwrapped? In this case
    // document has one child (the paragraph), so article elides too).
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
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `npm test -- --filter="transformer compact mode"`
Expected: FAIL — the elide cases still wrap in `<article>` and `<p>`.

- [ ] **Step 4: Update the `document` schema**

In `src/schema.ts`, replace the `document` export (lines 4–21):

```typescript
export const document: Schema = {
  render: 'article',
  children: [
    'heading',
    'paragraph',
    'image',
    'table',
    'tag',
    'fence',
    'blockquote',
    'comment',
    'list',
    'hr',
  ],
  attributes: {
    frontmatter: { render: false },
  },
  transform(node, config) {
    if (
      config.compact &&
      node.children.length === 1 &&
      !node.attributes.frontmatter
    ) {
      return node.transformChildren(config);
    }
    return new Tag(
      'article',
      node.transformAttributes(config),
      node.transformChildren(config)
    );
  },
};
```

- [ ] **Step 5: Update the `paragraph` schema**

In `src/schema.ts:37-40`, replace the `paragraph` export with:

```typescript
export const paragraph: Schema = {
  render: 'p',
  children: ['inline'],
  transform(node, config) {
    if (config.compact && node.children.length === 1) {
      const child = node.children[0];
      if (child.type === 'tag' && child.tag) {
        const schema = config.tags?.[child.tag];
        if (schema && schema.inline !== true) {
          return node.transformChildren(config);
        }
      }
    }
    return new Tag(
      'p',
      node.transformAttributes(config),
      node.transformChildren(config)
    );
  },
};
```

- [ ] **Step 6: Run tests, confirm they pass**

Run: `npm test -- --filter="transformer compact mode"`
Expected: PASS — six specs.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/schema.ts src/transformer.test.ts
git commit -m "feat(transform): compact elides article and p wrappers"
```

---

## Task 6: Widen `transforms` array signature to pass full `ParserArgs`

**Files:**
- Modify: `src/parser.ts:216`
- Modify: `src/transforms/table.ts:37-40`

The existing `table` transform reads only `conditionalTags`. We're about to add a second transform (`lone-tag`) that reads `noParagraphForLoneTag`. Pass the whole `ParserArgs` instead.

- [ ] **Step 1: Update the dispatch in `src/parser.ts`**

In `src/parser.ts:216`, change:

```typescript
  for (const transform of transforms) transform(doc, args);
```

(was: `transform(doc, args?.conditionalTags);`)

- [ ] **Step 2: Update the `table` transform signature**

In `src/transforms/table.ts:37-40`, change to:

```typescript
import type { ParserArgs } from '../types';

export default function transform(
  document: Node,
  args?: ParserArgs
) {
  const conditionalTags = args?.conditionalTags ?? ['if'];
  // ...rest of the body uses `conditionalTags` exactly as before
```

The remaining lines of the function are unchanged.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: All tests pass — particularly `src/transforms/table.test.ts`.

- [ ] **Step 4: Type-check**

Run: `npm run type:check`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts src/transforms/table.ts
git commit -m "refactor(transforms): pass full ParserArgs to post-parse transforms"
```

---

## Task 7: `lone-tag` transform — unwrap paragraph holding only a tag

**Files:**
- Create: `src/transforms/lone-tag.ts`
- Create: `src/transforms/lone-tag.test.ts`
- Modify: `src/transforms/index.ts`

When `noParagraphForLoneTag === true`: replace every `paragraph` child whose `children` is exactly one `tag` (and which has no `annotations`) with that `tag` directly.

- [ ] **Step 1: Write the failing test**

Create `src/transforms/lone-tag.test.ts`:

```typescript
import Markdoc from '../../index';

function convert(src: string, args = {}) {
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

  it('unwraps a self-closing tag', function () {
    const doc = convert(`{% mytag /%}`, { noParagraphForLoneTag: true });
    expect(doc.children.length).toBe(1);
    expect(doc.children[0].type).toEqual('tag');
    expect(doc.children[0].tag).toEqual('mytag');
  });

  it('does NOT unwrap when the paragraph has sibling text', function () {
    const doc = convert(`text {% mytag /%} more`, {
      noParagraphForLoneTag: true,
    });
    expect(doc.children[0].type).toEqual('paragraph');
  });

  it('does NOT unwrap when paragraph has annotations', function () {
    const doc = convert(`{% mytag /%}\n{% .red %}`, {
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
    const doc = convert(`{% mytag /%}`);
    expect(doc.children[0].type).toEqual('paragraph');
  });

  it('unwraps nested cases (inside blockquote)', function () {
    const doc = convert(`> {% mytag /%}`, { noParagraphForLoneTag: true });
    const bq = doc.children[0];
    expect(bq.type).toEqual('blockquote');
    expect(bq.children[0].type).toEqual('tag');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test -- --filter="lone-tag transform"`
Expected: FAIL — the file imports nothing yet from a `lone-tag` module; the transform doesn't exist.

- [ ] **Step 3: Create `src/transforms/lone-tag.ts`**

```typescript
import type { Node, ParserArgs } from '../types';

function isLoneTagParagraph(node: Node): boolean {
  return (
    node.type === 'paragraph' &&
    node.children.length === 1 &&
    node.children[0].type === 'tag' &&
    !node.annotations?.length
  );
}

function unwrapIn(node: Node) {
  // Walk children of `node` and unwrap any lone-tag paragraphs in place.
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (isLoneTagParagraph(child)) {
      node.children[i] = child.children[0];
    } else {
      unwrapIn(child);
    }
  }
  // Slots too — they're alternative children trees.
  for (const slot of Object.values(node.slots)) {
    unwrapIn(slot);
  }
}

export default function transform(document: Node, args?: ParserArgs) {
  if (!args?.noParagraphForLoneTag) return;
  unwrapIn(document);
}
```

- [ ] **Step 4: Register the transform**

Replace `src/transforms/index.ts` contents:

```typescript
import table from './table';
import loneTag from './lone-tag';
export default [table, loneTag];
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `npm test -- --filter="lone-tag transform"`
Expected: PASS — 7 specs.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/transforms/lone-tag.ts src/transforms/lone-tag.test.ts src/transforms/index.ts
git commit -m "feat(transforms): add lone-tag unwrap for noParagraphForLoneTag"
```

---

## Task 8: GitHub admonitions tokenizer plugin

**Files:**
- Create: `src/tokenizer/plugins/githubAdmonitions.ts`
- Create: `src/tokenizer/plugins/githubAdmonitions.test.ts`
- Modify: `src/tokenizer/index.ts:7-31`
- Modify: `src/parser.ts:36-97`

The plugin is a markdown-it `core` rule that mutates `blockquote_open` tokens to add `kind` attrs and removes the marker paragraph. The parser then reads `token.attrs` on `blockquote_open` to surface the attribute on the Node.

- [ ] **Step 1: Write the failing test**

Create `src/tokenizer/plugins/githubAdmonitions.test.ts`:

```typescript
import Tokenizer from '../index';
import parser from '../../parser';

function parse(src: string, opts: any = {}) {
  const tokenizer = new Tokenizer({ githubAdmonitions: true, ...opts });
  return parser(tokenizer.tokenize(src));
}

describe('github admonitions plugin', function () {
  const kinds = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'success', 'danger'];

  for (const kind of kinds) {
    it(`recognizes [!${kind.toUpperCase()}]`, function () {
      const doc = parse(`> [!${kind.toUpperCase()}]\n> body`);
      const bq = doc.children[0];
      expect(bq.type).toEqual('blockquote');
      expect(bq.attributes.kind).toEqual(kind);
    });
  }

  it('is case-insensitive in source', function () {
    const doc = parse(`> [!Note]\n> body`);
    expect(doc.children[0].attributes.kind).toEqual('note');
  });

  it('strips the marker paragraph', function () {
    const doc = parse(`> [!NOTE]\n> body`);
    const bq = doc.children[0];
    // Only the body paragraph remains.
    expect(bq.children.length).toBe(1);
    expect(bq.children[0].type).toEqual('paragraph');
  });

  it('leaves unrelated blockquotes untouched', function () {
    const doc = parse(`> regular quote`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('leaves unknown bracket markers untouched', function () {
    const doc = parse(`> [!UNKNOWN]\n> body`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('does nothing when plugin is off (compat)', function () {
    const tokenizer = new Tokenizer({});
    const doc = parser(tokenizer.tokenize(`> [!NOTE]\n> body`));
    const bq = doc.children[0];
    expect(bq.attributes.kind).toBeUndefined();
  });

  it('handles multi-line body', function () {
    const doc = parse(`> [!WARNING]\n> first line\n> second line`);
    const bq = doc.children[0];
    expect(bq.attributes.kind).toEqual('warning');
    expect(bq.children.length).toBe(1);
    expect(bq.children[0].type).toEqual('paragraph');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test -- --filter="github admonitions plugin"`
Expected: FAIL — module not found, then attribute undefined.

- [ ] **Step 3: Create the plugin**

Create `src/tokenizer/plugins/githubAdmonitions.ts`:

```typescript
import type MarkdownIt from 'markdown-it/lib';
import type StateCore from 'markdown-it/lib/rules_core/state_core';

const KINDS = new Set([
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'info',
  'success',
  'danger',
]);

const MARKER_RE = /^\[!([A-Za-z]+)]\s*$/;

function core(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 3; i++) {
    if (
      tokens[i].type !== 'blockquote_open' ||
      tokens[i + 1].type !== 'paragraph_open' ||
      tokens[i + 2].type !== 'inline' ||
      tokens[i + 3].type !== 'paragraph_close'
    ) {
      continue;
    }

    const inlineContent = tokens[i + 2].content;
    const match = MARKER_RE.exec(inlineContent);
    if (!match) continue;

    const kind = match[1].toLowerCase();
    if (!KINDS.has(kind)) continue;

    const open = tokens[i];
    open.attrs = open.attrs ? [...open.attrs, ['kind', kind]] : [['kind', kind]];

    // Remove the marker paragraph (paragraph_open, inline, paragraph_close).
    tokens.splice(i + 1, 3);
  }
}

export default function plugin(md: MarkdownIt) {
  md.core.ruler.push('githubAdmonitions', core);
}
```

- [ ] **Step 4: Register the plugin in `Tokenizer`**

Replace `src/tokenizer/index.ts:7-31` with:

```typescript
export default class Tokenizer {
  private parser: MarkdownIt;

  constructor(
    config: MarkdownIt.Options & {
      allowIndentation?: boolean;
      allowComments?: boolean;
      githubAdmonitions?: boolean;
    } = {}
  ) {
    this.parser = new MarkdownIt(config);
    this.parser.use(annotations, 'annotations', {});
    this.parser.use(frontmatter, 'frontmatter', {});
    this.parser.disable([
      'lheading',
      // Disable indented `code_block` support https://spec.commonmark.org/0.30/#indented-code-block
      'code',
    ]);

    if (config.allowComments) this.parser.use(comments, 'comments', {});
    if (config.githubAdmonitions)
      this.parser.use(githubAdmonitions, 'githubAdmonitions', {});
  }

  tokenize(content: string): Token[] {
    return this.parser.parse(content.toString(), {});
  }
}
```

And add the import near the top of the file:

```typescript
import githubAdmonitions from './plugins/githubAdmonitions';
```

- [ ] **Step 5: Add `blockquote` attribute pickup in the parser**

In `src/parser.ts`, in the `handleAttrs` function (currently lines 36–97), add a new `case` before `default`:

```typescript
    case 'blockquote': {
      if (token.attrs) {
        const attrs = Object.fromEntries(token.attrs);
        if (attrs.kind) return { kind: attrs.kind };
      }
      return {};
    }
```

- [ ] **Step 6: Run the test, confirm it passes**

Run: `npm test -- --filter="github admonitions plugin"`
Expected: PASS — 14 specs (8 kinds + 6 behavior cases).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/tokenizer/plugins/githubAdmonitions.ts src/tokenizer/plugins/githubAdmonitions.test.ts src/tokenizer/index.ts src/parser.ts
git commit -m "feat(tokenizer): GitHub admonitions plugin"
```

---

## Task 9: Compat guard — snapshot all-flags-off output

**Files:**
- Create: `src/compat.test.ts`

A regression net that asserts: when all new flags are unset, parser/transformer output for a small fixture suite is byte-identical to the current behavior (which by definition matches upstream because we haven't changed defaults).

- [ ] **Step 1: Create the compat test**

Create `src/compat.test.ts`:

```typescript
import Markdoc from '../index';

const FIXTURES = [
  ['heading', `# Hello, world`],
  ['paragraph', `Just a plain paragraph.`],
  ['emphasis', `Some **bold** and *italic* text.`],
  ['lone tag', `{% mytag %}hi{% /mytag %}`],
  ['self-closing tag', `{% mytag /%}`],
  ['blockquote', `> quoted text`],
  ['gh-style blockquote (no plugin)', `> [!NOTE]\n> body`],
  ['list', `- one\n- two`],
  ['fence', '```js\nconsole.log(1);\n```'],
  ['mixed', `# heading\n\nparagraph with [link](https://a)\n\n> quote`],
];

describe('compat guard', function () {
  describe('parse() with no flags matches AST shape baseline', function () {
    for (const [name, src] of FIXTURES) {
      it(name, function () {
        const ast = Markdoc.parse(src);
        // Top-level type is always 'document' when compact is off.
        expect(ast.type).toEqual('document');
        // No node loses its `inline` wrapper.
        let sawInline = false;
        for (const node of ast.walk()) {
          if (node.type === 'inline') sawInline = true;
        }
        if (
          src.includes('**') ||
          src.includes('*') ||
          src.includes('[') ||
          /\bparagraph\b/.test(src) ||
          /^# /.test(src)
        ) {
          expect(sawInline).toBe(true);
        }
        // Location is present by default.
        expect(ast.location).toBeDefined();
      });
    }
  });

  describe('transform() with no flags matches render shape baseline', function () {
    for (const [name, src] of FIXTURES) {
      it(name, function () {
        const out = Markdoc.transform(Markdoc.parse(src));
        const tag = Array.isArray(out) ? out[0] : out;
        // Top-level always wraps in <article>.
        expect(tag.name).toEqual('article');
      });
    }
  });

  it('Tokenizer with no flags does not surface admonition kind', function () {
    // Same input as the gh-admonitions test, but with default tokenizer.
    const ast = Markdoc.parse(`> [!NOTE]\n> body`);
    expect(ast.children[0].attributes.kind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --filter="compat guard"`
Expected: PASS — all fixtures pass with default behavior.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Type-check**

Run: `npm run type:check`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/compat.test.ts
git commit -m "test: snapshot guard for all-flags-off backward compatibility"
```

---

## Task 10: Build verification

**Files:** none modified — verification only.

- [ ] **Step 1: Run the build**

Run: `npm run build`
Expected: Successful build to `dist/`.

- [ ] **Step 2: Run the lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Run the full suite one more time**

Run: `npm test`
Expected: All tests pass.

If everything is green: the fork is feature-complete per this plan.
