# Markdoc fork: compact AST, lone-tag unwrap, GitHub admonitions

**Status:** Draft — pending user review
**Date:** 2026-05-27
**Author:** Roman Hotsiy

## Background

This repo is a fork of `@markdoc/markdoc`. The primary consumer parses many short Markdown descriptions embedded inside large YAML files. Three pain points have emerged:

1. The AST that `parse()` returns is verbose for short descriptions: every node carries `lines`, empty `annotations`/`errors` arrays, and short text gets wrapped in `document → paragraph → inline → text`.
2. CommonMark/Markdoc wraps a same-line `{% tag %}content{% /tag %}` in an implied paragraph. The consumer wants the tag at the top level, not inside `<p>`.
3. GitHub-style admonitions (`> [!NOTE]`) need to be recognized and surfaced as structured data without forcing every consumer to write their own tree walk.

## Goals

* Add an opt-in compact mode for both the AST (`parse`) and the renderable tree (`transform`) that drops redundant wrapper nodes and skips per-node location data.
* Add an opt-in flag that lifts same-line markdoc tags out of their implied paragraph wrapper.
* Recognize GitHub-style admonitions at tokenizer level and surface them as a `blockquote` Node with a `kind` attribute.
* Preserve byte-for-byte upstream behavior when none of these flags are set (strict compat).

## Non-goals

* Changing default behavior in any way.
* Generalized paragraph elision for content other than markdoc tags.
* User-space helpers for rendering admonitions (consumers decide how to render the `kind` attribute).
* Replacing the existing `location: false` flag (the new `compact` is a strictly stronger superset).

## Public API additions

```ts
// ParserArgs (src/types.ts)
type ParserArgs = {
  file?: string;
  slots?: boolean;
  location?: boolean;
  conditionalTags?: string[];
  compact?: boolean;              // NEW
  noParagraphForLoneTag?: boolean; // NEW
};

// Tokenizer constructor (src/tokenizer/index.ts)
new Tokenizer({
  allowIndentation?: boolean,
  allowComments?: boolean,
  githubAdmonitions?: boolean,    // NEW
  ...markdownItOptions
});

// Config (src/types.ts) — read by transformer
type ConfigType = {
  ...
  compact?: boolean;              // NEW
};
```

All three new options default to `false`. With all flags unset, parser, tokenizer, and transformer output match upstream `@markdoc/markdoc` byte-for-byte.

## Feature 1: Compact mode — parser

Triggered by `Markdoc.parse(src, { compact: true })`.

### Behavior changes inside `handleToken` (src/parser.ts)

1. **No `lines`, no `location`.** The block at parser.ts:154-167 that copies `token.map` to `node.lines` and `token.position` to `node.location` is skipped when `compact` is true. The existing `location: false` flag is a weaker version (suppresses only `location`); `compact` implies it and also skips `lines`.

2. **No `inline` wrapper Node.** When the recursion hits a token whose computed `typeName === 'inline'` (parser.ts:185-187), the code currently pushes an `inline` Node and recurses children into it. Under `compact`, the function recurses children directly into the current parent without creating the `inline` Node. The existing `inlineParent` variable (used so that `annotation` tokens can attach back to the parent) still gets set to the surrounding paragraph correctly because that variable already points to `parent` from before the `inline` Node was created.

3. **Lazy `errors` / `annotations` / `lines` arrays.** The `Node` class (src/ast/node.ts) is changed so these three properties start out `undefined`. Every internal mutation site (`node.errors.push`, `node.annotations.push`, `node.lines.push`, plus any spread) becomes a one-line helper that lazy-creates the array. The type widens:

   ```ts
   class Node {
     errors?: ValidationError[];
     annotations?: AttributeValue[];
     lines?: number[];
   }
   ```

   This is a typing breaking change for downstream consumers that index these arrays without optional chaining — acceptable for this fork.

### Behavior changes in the `parse` entrypoint (index.ts)

4. **Drop top-level `document` when single child.** After `parser()` returns, if all of the following hold:
   * `compact === true`
   * `doc.children.length === 1`
   * `Object.keys(doc.slots).length === 0`
   * `doc.errors` is empty or undefined
   * `doc.attributes` has no `frontmatter`

   then `parse` returns `doc.children[0]` instead of `doc`. The dropped `document` carries no data in this case.

## Feature 2: Compact mode — transformer

Triggered by `Markdoc.transform(node, { compact: true })`.

Implemented entirely inside the two schema definitions in `src/schema.ts`. The existing pattern in this file (see the `heading` schema) is that a schema's `transform` returns `new Tag(...)` directly when it needs custom rendering — we follow that pattern:

1. **`document` schema.** Add a `transform(node, config)` function. When `config.compact && node.children.length === 1 && !node.attributes.frontmatter`, return `node.transformChildren(config)` (the array of transformed children, flattened by the caller — same shape the `paragraph` default produces) — no `Tag('article', ...)` wrapper. Otherwise return `new Tag('article', node.transformAttributes(config), node.transformChildren(config))`, replicating the current default `render: 'article'` path.

2. **`paragraph` schema.** Add a `transform(node, config)`. When `config.compact && node.children.length === 1` and that child is a `tag` node whose resolved schema is not inline (`schema.inline !== true`), return `node.transformChildren(config)` (the single child's transformed output, again as the array shape). Otherwise return `new Tag('p', node.transformAttributes(config), node.transformChildren(config))`, matching today's default behavior (the `paragraph` schema has no explicit `render` today; default is `<p>`).

When a schema `transform` returns an array, `transformer.node` in src/transformer.ts already handles that case (it returns `RenderableTreeNodes` which is `RenderableTreeNode | RenderableTreeNode[]`). No changes to `src/transformer.ts`.

## Feature 3: `noParagraphForLoneTag`

Triggered by `Markdoc.parse(src, { noParagraphForLoneTag: true })`.

### The scenario

Source like `{% callout %}hi{% /callout %}` on its own line currently parses as:

```
document
└── paragraph
    └── inline
        └── tag(callout)
```

The block-level annotation handler in src/tokenizer/plugins/annotations.ts:51-81 rejects this case (because `{% /callout %}` is not flush with line-end after the opener), so it falls through to the paragraph rule. The CommonMark/Markdoc spec defends this as "the implied block-level paragraph element."

### Implementation

A new post-parse transform `src/transforms/lone-tag.ts`, registered in the existing `transforms` array at src/transforms/index.ts and applied at src/parser.ts:216.

Today the call site passes only `conditionalTags`:

```ts
for (const transform of transforms) transform(doc, args?.conditionalTags);
```

We widen the contract: the second argument becomes the full `ParserArgs` object. The existing `table` transform changes signature to read `args?.conditionalTags` off the object. The new `lone-tag` transform short-circuits unless `args?.noParagraphForLoneTag`.

The transform walks the doc. For every node that has children, it iterates its `children` array and replaces any element that satisfies all of:

* `child.type === 'paragraph'`
* `child.children.length === 1`
* `child.children[0].type === 'tag'`
* `child.annotations` is empty or undefined

with `child.children[0]` directly. Single shallow walk; no recursion into the lifted tag (its internal structure is already correct).

### Why a transform, not a markdown-it plugin

Doing this at token level means surgery on `paragraph_open`/`paragraph_close` token pairs around `tag` tokens. That fights markdown-it's ruler ordering and gets brittle. The Node tree is a cleaner place to spot "paragraph with exactly one tag child."

## Feature 4: GitHub admonitions

Triggered by `new Tokenizer({ githubAdmonitions: true })`.

### Recognized kinds

Eight, case-insensitive in source, lowercase in the `kind` attribute:

```
NOTE, TIP, IMPORTANT, WARNING, CAUTION, INFO, SUCCESS, DANGER
```

First five are the GitHub-blessed set; the latter three are common extensions in other markdown dialects (Docusaurus, MkDocs Material). Anything outside this set stays as a plain blockquote with the literal `[!FOO]` text intact.

### Output shape

```md
> [!NOTE]
> Helpful body text.
```

parses to:

```
blockquote(kind="note")
└── paragraph
    └── inline
        └── text("Helpful body text.")
```

### Implementation

1. **New plugin `src/tokenizer/plugins/githubAdmonitions.ts`.** It registers a `core` rule (runs after block parsing). The rule scans the token stream for the sequence:

   ```
   blockquote_open
   paragraph_open
   inline   (content matches /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER)]\s*$/i)
   paragraph_close
   (rest of blockquote body)
   blockquote_close
   ```

   When matched:
   * Add `['kind', <lowercase kind>]` to `blockquote_open.attrs`.
   * Splice out the marker paragraph (the three tokens `paragraph_open`, `inline`, `paragraph_close`).

2. **Registration in `Tokenizer`** (src/tokenizer/index.ts). When `config.githubAdmonitions`, `this.parser.use(githubAdmonitions, 'githubAdmonitions', {})`.

3. **Parser pickup of the attribute.** `handleAttrs` in src/parser.ts:36 currently has no `blockquote` case (falls into `default: return {}`). Add a `case 'blockquote':` that, when `token.attrs` contains `kind`, returns `{ kind: <value> }`. This is the only parser.ts change required; it's safe because non-admonition blockquotes have no `attrs` and still get `{}`.

### Why a core rule and not a Node transform

The user explicitly flagged the perf concern of running an extra tree walk per description in a hot YAML-processing loop. The core rule is one pass already inside markdown-it; piggybacking on it is free.

## Compat guarantee

When `compact === undefined`, `noParagraphForLoneTag === undefined`, and `githubAdmonitions === undefined`:

* `parse` returns a Node tree byte-identical to upstream `@markdoc/markdoc` (verified by a snapshot test against checked-in fixtures).
* `transform` returns a renderable tree byte-identical to upstream.
* The `Tokenizer` emits the same token stream.

The only un-flagged change is the optional-typed `errors` / `annotations` / `lines` on `Node` (Feature 1, point 3). Existing code that read `node.errors.length` will need `node.errors?.length`. This is the one accepted typing breaking change; it does not affect runtime semantics because the empty arrays were never load-bearing values.

## Testing

| File | Covers |
|---|---|
| `src/parser.test.ts` (extend) | `compact: true` strips `lines`/`location`/`inline` wrappers; empty `errors`/`annotations`/`lines` are `undefined`; top-level `document` unwrapped when single child; does NOT unwrap when frontmatter or errors present |
| `src/transformer.test.ts` (extend) | `compact: true` elides `<article>` when document has single child; elides `<p>` when paragraph wraps a single block-level tag; does NOT elide when multi-child or inline tag |
| `src/transforms/lone-tag.test.ts` (new) | Lone same-line tag unwraps to direct child of document; tag with sibling text in same paragraph does NOT unwrap; multi-line block tag unchanged |
| `src/tokenizer/plugins/githubAdmonitions.test.ts` (new) | All 8 kinds recognized; case-insensitive; `kind` attribute is lowercase; non-admonition blockquotes untouched; `[!UNKNOWN]` stays as plain blockquote text; nested admonitions; admonition with multi-line body |
| Snapshot guard (new, e.g., `src/compat.test.ts`) | Runs the existing fixture set with all new flags unset and asserts identical output to a checked-in baseline. The regression net for the compat promise. |

## Out of scope (deferred or rejected)

* Generalized paragraph elision (e.g., dropping `<p>` around any single inline element). Rejected — too easy to break CommonMark semantics.
* Configurable admonition kind list. Deferred — can be added later as `githubAdmonitions: { kinds: [...] }` without breaking the boolean form.
* Tokenizer-level (not parser-level) lone-tag unwrap. Rejected per Feature 3 discussion.
* User-space admonition rendering helpers. Out of scope — consumers own rendering.

## Open questions resolved during brainstorming

* **Fork posture:** strict compat, opt-in only.
* **Compact applies to:** both `parse` (AST) and `transform` (renderable tree).
* **Empty array handling:** AST mutation with widened type (`T[] | undefined`), not a JSON helper.
* **Unwrap scope for paragraph-wrap fix:** markdoc tags only, not arbitrary inline content.
* **Admonition output shape:** `blockquote` Node with `kind` attribute.
* **Admonition kinds:** the 8 listed above (GitHub 5 + info/success/danger).
