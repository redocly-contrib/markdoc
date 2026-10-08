# Changelog

`@redocly/markdoc` is a fork of [`@markdoc/markdoc`](https://github.com/markdoc/markdoc).
This file records how the fork differs from upstream and what changes between
fork releases. Upstream's own history is not repeated here.

Current upstream base: **0.5.10**.

## 0.6.2 (unreleased)

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
