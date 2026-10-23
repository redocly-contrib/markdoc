# Changelog

`@redocly/markdoc` is a fork of [`@markdoc/markdoc`](https://github.com/markdoc/markdoc).
This file records how the fork differs from upstream and what changes between
fork releases. Upstream's own history is not repeated here.

Current upstream base: **0.5.10**.

## 0.7.0 (unreleased; preview: 0.7.0-beta.1 on the `next` tag)

Markdoc now has its own parser, and markdown-it is gone. The AST is unchanged:
on the 8,940 documents of the Redocly corpus, under six settings, it is
byte-identical to 0.6.4's.

### Breaking

- **`Markdoc.Tokenizer` is removed, and `parse()` takes only a string.** The
  tokenizer settings are now `parse()` options:

  ```js
  // 0.6.x
  const tokenizer = new Markdoc.Tokenizer({ html: true, allowIndentation: true, allowComments: true });
  const ast = Markdoc.parse(tokenizer.tokenize(source), { slots: true });

  // 0.7
  const ast = Markdoc.parse(source, { html: true, allowIndentation: true, allowComments: true, slots: true });
  ```

  The options are `html`, `allowIndentation`, `allowComments`,
  `allowLinkValidation`, `linkValidationOptions` and `githubAdmonitions`,
  plus the new `linkify`.
- **`tokenize(source, { stopAfter })` and `tokenizeUntil` are removed**, with
  the token API. For a page's title, use `parseFirstHeading` (below).
- **markdown-it options are not accepted:** `linkify` is now GitHub-style (see
  below); `typographer` and `maxNesting` are gone.
- **Patching markdown-it's rules no longer works.** The portal, API docs and
  editor emptied the `reference` rule's terminators to work around
  markdown-it#996. The parser fixes the underlying problem instead (see
  below), and keeps CommonMark's reference definition rules.

### Added

- **`linkify: true`** turns bare `www.`, `http(s)://` and `ftp://` URLs and
  email addresses into links, following GitHub's rules (cmark-gfm's autolink
  extension): the same boundaries, domain checks and trimming of trailing
  punctuation, unbalanced parentheses and entities. Text inside links and
  code is left alone.
- **`htmlTags()` from `@redocly/markdoc/dist/html.js`**, ported from Redocly
  Realm. `parse(source, { html: htmlTags() })` turns raw HTML into `html`
  tags with React-converted attributes, the markdown between an element's
  opening and closing tags as their children. The entry bundles htmlparser2,
  so the main bundle does not grow. `html` also accepts any `HtmlHandler`.
  It fixes four bugs in Realm's version:
  - an unclosed element is closed with its `markdoc-error` tag inside it,
    innermost first (Realm put each error inside the element opened after
    it);
  - text at the end of the HTML that could start an entity (`&am`) is kept;
  - boolean attributes are `true`, so `<details open>` and
    `<input disabled>` render as written (React drops `''`);
  - a `style` value keeps its colons and semicolons
    (`background:url(https://…)`).
- **`parseAndValidate(source, config, args)`** returns `{ ast, errors }`, or
  a promise of it when a validator is asynchronous.
- **`parseFirstHeading(source, { ...options, skip })`** returns a document's
  first heading Node without parsing the rest of it.
  - It skips headings in slots and in tags `skip(tagNode)` rejects. `skip`
    gets each tag before its children are parsed, so it must decide by the
    tag's name and attributes.
  - It always returns the node `findFirstHeading(parse(source, options), skip)`
    would. When the heading uses a link reference defined later, is inside a
    `table` tag, or it or content before it could leave a tag open around
    later blocks, it parses the whole document to be sure.
  - The first heading of all 1,129 corpus pages takes 9 ms, against 41 ms for
    0.6.4's `tokenizeUntil` and 195 ms for a full parse.
- **`formatScalar(value)`** is exported: an attribute value as the formatter
  writes it in a tag (`"text"`, `[1, 2]`, `{a: 1}`, `$var`, `fn(1)`).
- **`frontmatter: false`** turns off frontmatter parsing. It is on by default,
  as before.
- **`prepareConfig(config, { cloneAst })`**: merges the built-in schemas once,
  for repeated `transform` and `validate` calls. With `cloneAst: false`,
  `transform` copies only the nodes that hold variables or functions.
- **`Ast.pack(ast, { compact: true })` / `Ast.unpack(value)`**: a lossless,
  JSON-compatible storage format, about 3× smaller than compact JSON and
  faster to load. `unpack` takes the already-parsed value.

### Fixed

- **A run of link reference definitions took quadratic time**
  (markdown-it#996): 8,000 definitions took 2.1 s, and now take 20 ms.
- **An unclosed inline tag in link text (`[a {% t %}](/u)`) threw a
  `TypeError`.** The stray link close now becomes a node with a
  `missing-opening` error, like other unmatched closes.
- **A comment in link text (`[<!--x-->](/u)`, with `allowComments`) hung the
  parser.**
- **The CommonJS builds name their exports for Node**, so
  `import { parse } from '@redocly/markdoc'` and
  `import { htmlTags } from '@redocly/markdoc/dist/html.js'` work from ES
  modules.

### Performance

Measured on the Redocly corpus against 0.6.4 (see `bench/REPORT.md`):

- builds are 1.7–1.8× faster with the same steps, and 2.2–3.4× faster with
  `prepareConfig` and `Ast.pack`; source → AST alone is 2.2–3.5× faster;
- loading and rendering at runtime is 1.3–1.6× faster with the same steps,
  and 3–5.6× faster with `prepareConfig` and `Ast.unpack`;
- the bundle is 63 KB gzipped, down from 67.5 KB (49 KB against 51 KB
  minified); the optional `dist/html.js` entry adds 33 KB.

## 0.6.4

### Fixed

- **`errors`, `annotations` and `slots` are readable again on every node**,
  reverting the breaking change from 0.6.0. They read as `[]`, `[]` and `{}` on
  a fresh parse, a compact parse, `compact()` output and an `Ast.fromJSON`
  revival, and their types are non-optional again, so upstream-style code
  compiles and runs:

  ```js
  // Worked upstream, threw in 0.6.0-0.6.3, works again
  if (node.annotations.length > 0) { /* ... */ }
  node.errors.push(error);
  ```

  The size saving is kept, but moved: `Node.prototype.toJSON` omits these
  fields while they are empty rather than leaving them undefined. Because the
  value exists from construction, merely *reading* a field can no longer change
  what gets serialized — a hazard the previous lazy approach had. A field that
  becomes non-empty, by `push` or by assignment, serializes.

### Changed

- **Smaller serialized nodes.** `toJSON` now also omits:
  - `inline` when it is `false`, which was written on every block node;
  - `location` when it carries no file and no line, which nodes built from
    tokens without a `map` were emitting as `{"start":{},"end":{}}`.

  Applies to any `JSON.stringify` of a Node, not just `compact()` output.
  `Ast.fromJSON` restores every omitted field from the constructor defaults, so
  a revived tree behaves identically to the original.

- **`compact()` drops `annotations` on `tag` nodes.** After parsing, a tag's
  annotation values are also in `attributes`, and the formatter prints a tag
  from `attributes`, so `format()` output is byte-identical without them.
  Annotations on other node types are kept — a fence's `title`, for one, is not
  mirrored in `attributes` and is read back from stored trees at render time.

  Measured on a tag-heavy synthetic page: ~11% smaller than 0.6.3 (~8% from
  `inline`, ~5% from tag annotations), and ~52% smaller than a full parse.

## 0.6.3

### Added

- **`Markdoc.compact(node)`** (also `Markdoc.Ast.compact`) — rewrites a parsed
  AST into the shape `parse(src, { compact: true })` would have produced, for
  storing it as JSON.

  Engines have to parse *with* locations, because resolvers need them to report
  problems and link ranges. Once resolution is done those locations and the
  implied `inline` wrapper Nodes are dead weight in the stored JSON. This is the
  boundary function: parse fully, resolve, then compact before writing.

  ```js
  const ast = Markdoc.parse(source);     // locations intact for resolvers
  // ...resolve, validate...
  store(JSON.stringify(Markdoc.compact(ast)));
  ```

  Measured ~44% smaller stored ASTs across 3,334 real pages (971.5 MB → 544.9
  MB), and ~49% on a synthetic heading-and-list heavy page.

  Reach it through the default import:

  ```js
  import Markdoc from '@redocly/markdoc';
  Markdoc.compact(ast);
  ```

  A **named** import (`import { compact } from '@redocly/markdoc'`) resolves
  under bundlers, which read the `module` field, but **not when Node itself
  loads the package from ESM**: Node reads `main` (CJS) and `cjs-module-lexer`
  misdetects the export names. This affects every binding in the package, not
  just `compact`, and is inherited from upstream rather than new here. Use the
  default import for code Node loads directly.

  Accepts a `Node` or a `Node[]`, and returns the same shape. Never mutates its
  input — callers may still be holding the full AST. New Nodes, attribute
  objects, child arrays and slot maps are created; attribute *values*, including
  `Variable` and `Function` instances, are shared as-is.

  Two deliberate differences from a compact parse:

  - The root is always kept. A compact parse unwraps a single-child `document`;
    documents are stored and rendered as documents.
  - Errors are preserved wherever they exist, so a stored AST keeps its
    diagnostics. `errors`, `annotations` and `slots` are present only when
    non-empty, and slots are compacted recursively.

  `toJSON` is unchanged, so callers that still need to serialize a full AST with
  locations — a parse cache, for instance — are unaffected.

- **`tokenizer.tokenizeUntil(content, createStopAfter)`** — like
  `tokenize(content, { stopAfter })`, but the work is proportional to the prefix
  up to the match rather than to `content.length`.

  `stopAfter` only short-circuits the block loop. `StateBlock` setup (building
  line-mark tables for every line) and core `normalize` still run over the whole
  string, so finding a heading on line 1 of a 570 KB document cost ~1.9 ms.
  `tokenizeUntil` tokenizes growing line-aligned prefixes instead, accepting one
  only when the match is far enough from the cut to be unaffected by it:

  ```js
  tokenizer.tokenizeUntil(src, () => (t) => t.type === 'heading_close');
  ```

  Measured, heading on line 1:

  | document | `stopAfter` | `tokenizeUntil` |
  |---|---|---|
  | 609 B | 13 µs | 8 µs |
  | 5.7 KB | 37 µs | 5 µs |
  | 57 KB | 185 µs | 5 µs |
  | 570 KB | 2029 µs | 5 µs |

  Prefix attempts are capped, so a document whose match is deep or absent stays
  at parity with `stopAfter` rather than paying for retries.

  The parameter is a **factory** rather than a predicate because each attempt
  re-tokenizes from the first token, so a stateful predicate (one tracking
  `{% slot %}` depth, say) needs a fresh instance per attempt.

  The matched token and every token before it are identical to what
  `tokenize(content, { stopAfter })` returns. As with `stopAfter`, enclosing
  blocks are closed wherever parsing stopped, so their end maps are not
  meaningful.

  `tokenize` is unchanged.

## 0.6.2

### Fixed

- **GitHub admonitions failed validation.** The tokenizer sets a `kind`
  attribute on `blockquote`, but the `blockquote` schema declared no
  attributes, so every `> [!NOTE]` produced `attribute-undefined`. Because
  admonitions are on by default, this affected any consumer that validates.
  `kind` is now declared on the schema, validated against the recognized kinds,
  and rendered as `data-kind`.
- **The formatter dropped the admonition marker.** `format(parse(src))` lost
  the `> [!KIND]` line, so round-tripping an admonition through a visual editor
  would have deleted it. The marker is now written back as the first quoted
  line.
- **A `render` override on `document` or `paragraph` was ignored.** The custom
  `transform` functions added in 0.6.0 for compact mode always built their own
  `Tag`. Both are removed; compact-mode wrapper elision now lives in
  `transformer.node`, so the default render path — and any `render` override —
  applies whenever no elision happens. A custom `transform` still takes
  precedence over elision.

### Changed

- **`table-syntax` reporting is now opt-in** via `ParserArgs.strictTables`,
  default `false`. **This diverges from upstream**, which reports these errors
  by default as of 0.5.10.

  The offending node is dropped in both modes, exactly as it was before the
  check existed, so rendering is unchanged — only the diagnostic is gated.
  Reporting by default would turn content written before the check into a build
  failure for consumers that treat any node error as fatal. Turn it on for
  tools that must not silently discard content, such as a visual editor:

  ```js
  Markdoc.parse(source, { strictTables: true });
  ```

- `SchemaChild` widened from `NodeType` to `NodeType | (string & {})`. Node
  types are derived from token types at runtime and consumers add their own
  (e.g. `html_block`, `html_inline` from custom HTML token processing), so
  upstream's strict union forced casts.

## 0.6.1

### Added

Absorbed a formatter patch that previously lived as a `patch-package` patch
over the built bundle, reimplemented in source:

- Link and image destinations are wrapped in angle brackets when they contain
  whitespace, with `\`, `<` and `>` escaped; titles escape `\` and `"`.
  Previously only `()` was escaped and titles were interpolated raw, so a
  destination or title needing escaping did not survive a round-trip.
- Code spans follow CommonMark: the delimiter is longer than the longest
  backtick run in the content, and content is space-padded when it would
  otherwise begin or end with a backtick.
- GFM tables write column alignment markers (`:---`, `:---:`, `---:`), indent
  every row, and size columns to fit the markers.
- Table cells escape `|` when written as a GFM pipe table. Markdoc's own
  `{% table %}` list syntax is unaffected.
- A fence with empty content no longer gains a blank line.
- New option `format(v, { escapeText: false })` writes text nodes verbatim, for
  a caller that has escaped the text itself.
- A `{% table %}` header row that is not a list is reported as `table-syntax`
  (made opt-in in 0.6.2, see above).

### Breaking

Formatter **output** changed in two ways. Snapshot and round-trip tests will
need updating:

- A link whose text equals its href is written `[url](url)` rather than the
  autolink form `<url>`, so that a destination needing escaping round-trips.
- A blank line inside a blockquote is written `>` rather than `> `, so output
  carries no trailing whitespace.

## 0.6.0

Rebased onto upstream 0.5.10.

### Added

- **Compact AST** — `parse(src, { compact: true })` and
  `transform(node, { compact: true })`. Skips `location`, drops the implied
  `inline` wrapper Nodes, unwraps a single-child `document`, and elides
  `<article>`/`<p>` wrappers that carry no information. Intended for the many
  short descriptions embedded in large API specs.
- **`noParagraphForLoneTag`** — `parse(src, { noParagraphForLoneTag: true })`
  lifts a same-line `{% tag %}…{% /tag %}` out of the paragraph the
  implied-paragraph rule wrapped it in.
- **GitHub-style admonitions** — `> [!NOTE]` and friends become a `blockquote`
  with a lowercase `kind` attribute. Recognized kinds: `note`, `tip`,
  `important`, `warning`, `caution`, `info`, `success`, `danger`.

  **On by default.** Opt out with `new Tokenizer({ githubAdmonitions: false })`
  or `parse(src, { githubAdmonitions: false })`.
- **Early tokenizer stop** — `tokenize(src, { stopAfter })` aborts as soon as a
  token matching the predicate has been emitted, returning exactly the prefix a
  full parse would produce. Extracting the first heading becomes one pass:

  ```js
  tokenizer.tokenize(src, { stopAfter: (t) => t.type === 'heading_close' });
  ```

  A document with no matching token still costs a full parse.

### Breaking

- **`Node.lines` and `Node.pushLines()` removed.** Spans derive from
  `Node.location`. `ValidateError.lines` still exists on the public error shape
  but is now derived rather than stored per Node.
- **`Node.location.end.line` for a multi-line markdoc tag** now covers the
  whole block (open through close) instead of only the opening token. This
  fixed a bug: `lines[lines.length - 1]` was the previous workaround, so code
  that compensated should now read `location.end.line` directly and drop the
  adjustment.
- **`Node.slots`, `Node.errors` and `Node.annotations` are lazy** — `undefined`
  until first written, rather than eagerly `{}` / `[]`. This is what shrinks
  the serialized AST. Reads need `?.` or `?? []`:

  ```js
  node.errors?.length          // not node.errors.length
  Object.values(node.slots ?? {})
  ```

  Writes go through `addError()`, `addAnnotation()` and `addSlot()`.
- **`transform(node)` returns `RenderableTreeNodes`** (`RenderableTreeNode | RenderableTreeNode[]`)
  rather than `RenderableTreeNode`, because compact mode can elide a wrapper and
  return the children array.
