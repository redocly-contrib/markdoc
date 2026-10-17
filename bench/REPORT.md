# Markdoc performance & AST size — experiment report

Branch `perf/fast-parser` (built on `perf/explore`), against the published
`@redocly/markdoc@0.6.4`. Every number below was measured on the real Redocly
content; raw outputs are in `bench/results/`.

## TL;DR

Markdoc now has its own TypeScript parser, built mdastic-style, and markdown-it
is gone. The AST is byte-identical to 0.6.4's on the whole corpus.

| | 0.6.4 | this branch, same steps | this branch, fast path |
|---|---|---|---|
| **Build**, pages (parse → validate → serialize) | 789 ms | 430 ms (1.8×) | **363 ms (2.2×)** |
| **Build**, API descriptions | 177 ms | 102 ms (1.7×) | **53 ms (3.4×)** |
| **Runtime**, pages (deserialize → transform → React) | 684 ms | 432 ms (1.6×) | **198 ms (3.5×)** |
| **Runtime**, API descriptions | 118 ms | 89 ms (1.3×) | **31 ms (3.8×)** |
| **Runtime**, API descriptions embedded in a parsed API definition | 124 ms | 93 ms (1.3×) | **22 ms (5.6×)** |
| **Stored AST**, pages (6.66 MB of markdown) | 29.2 MB | 29.2 MB | **10.1 MB (2.9× smaller)** |
| **Bundle** (gzip) | 67.5 KB | 59.4 KB | 59.4 KB |

- **Same steps:** the calls the portal makes today, written for this branch:
  `parse(source, options)`, `validate`, `compact` + `JSON.stringify`,
  `fromJSON`, `transform`.
- **Fast path:** the new opt-in calls — `prepareConfig(config, { cloneAst: false })`,
  `Ast.pack(ast, { compact: true })` to store and `Ast.unpack(value)` to load.
- Output is identical in both.

Also new, for Redocly:
- **GitHub-style `linkify`.**
- **Your Realm HTML handler** as an optional, built-in `htmlTags()`.
- **Link reference definitions in linear time.** This fixes markdown-it#996,
  so the three places that patch markdown-it for it can stop.
- **`parseAndValidate`.**
- **A fix for a crash 0.6.4 has** on unclosed tags in link text.

## Setup

- **Corpus:**
  - 1,129 pages from `docs/realm`, `docs/intranet` and
    `packages/portal/playground` (6.66 MB);
  - 7,811 `description` strings from the Rebilly OpenAPI definition
    (0.49 MB, median 34 characters).
  - The corpus is cached in `bench/.cache/` (gitignored, never committed).
- **Config:** every custom tag the corpus uses, declaring every attribute
  it passes (47 custom tags).
- **Parse settings:** pages use the portal's (`html`, `allowIndentation`,
  `allowComments`); descriptions use the defaults with `compact: true`.
- **Machine:** darwin, 11 cores, Node 24.21. The machine is shared and was
  heavily loaded (load average 12–57).
  - All timings are **process CPU time** (user+sys); each figure is the
    median of interleaved rounds.
- **A/B runs** keep each library build in its own process.
  - Two copies of Markdoc in one process made whichever was required first
    ~35% faster, even when the files were byte-identical.
  - An A/A run agrees within ~3%. Stages under 10 ms, and the renderers,
    move by 10–20% with what else the worker process runs.
- **Correctness:**
  - `bench/ab.mjs` checks, before timing, that the branch matches 0.6.4 on
    all 8,940 documents: parsed AST, stored JSON, validation errors,
    renderable tree, HTML and React element tree.
  - The unit suite (470 specs) replays 523 recorded test inputs against
    0.6.4 under several settings.

## Where 0.6.4 spends its time

Pages, sum of all stages = 1.83 s:

| tokenize | parse | validate | compact+stringify | **revive** | transform | html | react |
|---|---|---|---|---|---|---|---|
| 19% | 9% | 16% | 9% | **28%** | 10% | 5% | 5% |

- **Revive:** reviving stored JSON costs more than tokenizing markdown did.
  `JSON.parse(text, reviver)` calls back into JS for every value and turns
  off V8's JSON fast path.
- **`mergeConfig`:** for short API descriptions it was 86% of `transform`.
  Every `transform`/`validate` call spreads ~90 schemas into fresh objects.
- **`transform`** also deep-copies the whole AST first.
- **Parsing:** markdown-it's rules, ~18% for Markdoc's plugins, and a
  separate pass turning tokens into Nodes.

## 1. The new parser (`src/fastparse`)

The fastest JS markdown parsers beat markdown-it mostly through their
machinery, not their grammar. So the new parser keeps Markdoc's exact grammar
and replaces the machinery.

- **Same grammar:** markdown-it 12.3.2's CommonMark rules, plus tables and
  strikethrough.
  - Markdoc's indentation rules, tags, annotations, comments, frontmatter,
    GitHub admonitions and link validation.
  - `parser.ts`'s token-to-Node logic, odd cases included.
- **mdastic-style machinery:**
  - Line offsets in typed arrays reused across documents, found with
    `indexOf`.
  - Pooled token objects.
  - Nodes built as tokens are consumed, with no separate tokens-to-AST pass.
  - First-character rule dispatch.
  - Sticky regexes instead of `src.slice(pos)` copies.
  - Skips work Markdoc never reads, such as image labels, and the table
    transform on documents without tables.
  - Memoizes URL normalization.
- **No markdown-it:** its few helpers (entity tables, URL normalization) are
  vendored, using the same `entities`, `mdurl`, `punycode` and `uc.micro`
  packages, so results match.

**Correctness**, against 0.6.4 (`parse(new Tokenizer(cfg).tokenize(src), args)`):

| check | result |
|---|---|
| all 8,940 corpus documents × 6 settings (26,000+ parses) | byte-identical AST |
| 523 inputs recorded from the test suites, × 3 argument variants (unit test) | identical |
| marktest suite | output identical |
| random documents from markdown edge-case fragments (10,000+ × 5 settings, plus a 30-minute run) | 0 mismatches |
| real corpus documents mutated (lines dropped, duplicated, re-indented, characters spliced; 7,800 × 5 settings) | 0 mismatches |
| reference-definition-heavy random documents (4,000 × 5 settings) | 0 mismatches |

**One deliberate difference: 0.6.4 crashes, the branch doesn't.**
- An unclosed inline tag in link text (`[a {% t %}](/u)`) makes 0.6.4 throw
  a `TypeError` out of `parse`.
- The branch turns the unmatched link close into a node with a
  `missing-opening` error, as Markdoc does for every other unmatched close.
- The comparisons skip inputs where 0.6.4 throws.

**Speed**, source text → AST, each engine in its own process (`bench/exp-engines.mjs`):

| | pages | vs 0.6.4 | descriptions | vs 0.6.4 |
|---|---|---|---|---|
| markdoc 0.6.4: markdown-it tokens + parse | 432 ms | 1.00× | 76.1 ms | 1.00× |
| **this branch** | **180 ms** | **2.40×** | **22.0 ms** | **3.46×** |
| mdastic 0.1 (mdast, no Markdoc tags) | 155–212 ms | 2.0–2.8× | 14–18 ms | 4.3–5.4× |
| commonmark.js 0.31 (no tables, no Markdoc tags) | 143 ms | 3.01× | 17.5 ms | 4.35× |

The two are in the same class, and the branch does more work: Markdoc tags
and annotations, and a `location` (three allocations) on every node. Engine
timings vary by up to ~30% between runs on this loaded machine; the ranges
show two runs.

### API

```js
const ast = Markdoc.parse(source, {
  html: true,               // or htmlTags(), see below
  allowIndentation: true,   // indent anything; never makes a code block
  allowComments: true,      // <!-- comments --> become comment nodes
  linkify: true,            // GitHub-style bare URL/email links
  githubAdmonitions: true,  // > [!NOTE] blockquotes get a kind (default)
  allowLinkValidation: true,
  file: 'page.md',
  slots: true,
});
```

Breaking, compared with 0.6.x:
- **The token API is gone.** No `Markdoc.Tokenizer`, and `parse()` takes only
  a string. Its settings moved to `parse()` options.
- **`stopAfter` and `tokenizeUntil` are gone** with it.
- **Two markdown-it options are gone:** `typographer`, which turned `(c)` into
  © and straight quotes into curly ones, and `maxNesting`, a nesting-depth
  safety limit. The parser keeps a fixed internal limit. `linkify` is now
  GitHub-style.

The bundle is smaller than 0.6.4's: 59.4 KB gzipped, against 67.5 KB.

## 2. Redocly features

### `linkify: true`, GitHub-style

Bare URLs and email addresses become links following GitHub's own rules
(cmark-gfm's autolink extension), not linkify-it's fuzzy matching:

- **Which links:** `www.` links, `http://`, `https://` and `ftp://` URLs, and
  email addresses.
- **Boundaries and domains:** the same boundary rules as GitHub, and no `_`
  in the last two domain labels.
- **Trimming:** trailing `?!.,:*_~'"`, a trailing `&entity;` and unbalanced
  closing parentheses are trimmed off.
- **Never inside** links, link text, images or code.
- **No effect on link brackets:** how `[`…`]` match is unchanged.

All the GFM spec's autolink examples are unit tests and pass. It is off by
default.

### `htmlTags()` — your Realm HTML handler, built in

```js
import { htmlTags } from '@redocly/markdoc/dist/html';
Markdoc.parse(source, { html: htmlTags() });
```

- It's ported from `realm-plus/.../html-tokens.ts` and `html-jsx-attributes.ts`.
- Elements become `html` tags with `name` and React-converted `attrs`.
  Markdown between an element's opening and closing tags becomes their
  children.
- An element still open at the end is closed after a `markdoc-error` tag (the
  name is configurable). Names that can't be React elements stay text.
- It runs inside the parser: no extra pass over tokens, and the document's
  HTML blocks form one run, as in Realm.
- It is a separate entry point that bundles `htmlparser2` 8.0.2, the version
  Redocly pins, so the main bundle doesn't grow.

**Checked against Realm's actual code.** `bench/exp-html.mjs` bundles Realm's
`html-tokens.ts` straight from the Redocly repo (nothing is copied) and runs it
on 0.6.4's tokens, as Realm's parse cache does:

| check | result |
|---|---|
| all 1,129 pages (373 contain HTML), with Realm's and the portal's parse arguments | identical |
| all 7,811 descriptions, compact | identical |
| 3,000 random HTML-heavy documents × 2 settings | 0 mismatches |

The portal and API docs carry older variants of the handler. Switching them to
`htmlTags()` gives them Realm's handling of unclosed elements and invalid
names.

### Link reference definitions: linear time (markdown-it#996)

- **The bug:** markdown-it reads each definition from the text of its whole
  block, so a run of N definitions costs O(N²).
- **The fix:** the parser reads only as many of the block's lines as a
  definition needs, widening the window only when the parse reaches its last
  line. It keeps CommonMark's rules, including what may interrupt a
  definition.

| definitions in a row | 1,000 | 2,000 | 4,000 | 8,000 |
|---|---|---|---|---|
| before (markdown-it's algorithm) | 29 ms | 114 ms | 450 ms | 2108 ms |
| after | 1.8 ms | 2.1 ms | 3.7 ms | 19.5 ms |

Redocly's workaround emptied the reference rule's terminators, so nothing could
interrupt a definition. That isn't needed any more, and the standard behavior
is back.

### `parseAndValidate(source, config, args)` → `{ ast, errors }`

This is one call. It is not a different algorithm: validators must see the
finished tree, after the table and lone-tag transforms rebuild parts of it, so
validation still walks the tree once at the end.

- **Positions:** the AST keeps them for error locations (and for future
  change highlighting).
- **Storage:** `Ast.pack(ast, { compact: true })` drops them.

## 3. Stage by stage

Each build runs in its own worker processes, which run every stage over the
whole corpus.

| stage | pages 0.6.4 | pages branch | | descriptions 0.6.4 | descriptions branch | |
|---|---|---|---|---|---|---|
| **source → AST** | 471 ms | 217 ms | **2.17×** | 65.5 ms | 19.9 ms | **3.30×** |
| validate | 287 ms | 189 ms | **1.52×** | 73.9 ms | 71.8 ms | 1.03× |
| validate (prepared config) | 287 ms | 182 ms | **1.58×** | 73.9 ms | 23.4 ms | **3.16×** |
| compact + stringify | 159 ms | 145 ms | 1.10× | 17.0 ms | 14.5 ms | 1.18× |
| revive (`fromJSON`) | 526 ms | 260 ms | **2.02×** | 45.2 ms | 15.7 ms | **2.88×** |
| transform | 192 ms | 148 ms | 1.30× | 66.5 ms | 55.9 ms | 1.19× |
| transform (prepared config) | 192 ms | 144 ms | 1.34× | 66.5 ms | 24.9 ms | **2.67×** |
| render html | 84.2 ms | 63.0 ms | 1.34× | 6.03 ms | 4.97 ms | 1.21× |
| render react | 83.3 ms | 70.9 ms | 1.18× | 6.81 ms | 6.51 ms | 1.04× |
| **sum of plain stages** | **1803 ms** | **1093 ms** | **1.65×** | **281 ms** | **189 ms** | **1.48×** |

The React renderer's code is unchanged; its speed-up here comes from the
worker no longer running markdown-it. End-to-end numbers come out lower than
these stage sums, because there each document's AST becomes garbage as soon as
it's done.

Other changes, besides the parser:
- **`Ast.fromJSON`:** `JSON.parse`, then one walk that revives class
  instances.
- **`Node.walk()`:** iterative instead of one nested generator per ancestor.
- **`validate`:** no generator, and no per-node temporaries.
- **`transform`:** no merged attribute schemas built per node.
- **HTML renderer:** output appended into one string.

## 4. Opt-in runtime and storage APIs

- **`prepareConfig(config)`** merges the built-in schemas once.
  - It survives `{ ...prepared, variables }` spreads.
  - It is reused only while `tags`/`nodes`/`functions` are the same objects
    it merged.
  - Opt-in because it is a snapshot: tags added in place later aren't seen.
  - An automatic, exactly-correct cache only reached 1.4×, because checking
    ~90 keys costs about as much as copying them.
- **`{ cloneAst: false }`:** transform copies only the nodes on the way to a
  variable or function.
  - Output is identical.
  - Only a schema transform that mutates its input node could tell the
    difference. None of Markdoc's or Redocly's runtime schemas do.
- **`Ast.pack` / `Ast.unpack`:** a lossless storage format that is still
  plain JSON.
  - Nodes are recognized by position.
  - Plain text is stored as a bare string.
  - Rare fields go under `$`-keys.

| format | pages raw | gzip | brotli | decode¹ | descriptions raw | decode¹ |
|---|---|---|---|---|---|---|
| compact JSON (today) | 29.18 MB | 3.10 MB | 2.80 MB | 270 ms | 2.47 MB | 32.8 ms |
| lean JSON (objects, defaults omitted) | 16.03 MB | 2.86 MB | 2.65 MB | 142 ms | 1.25 MB | 12.6 ms |
| **packed** | **10.14 MB** | 2.70 MB | 2.51 MB | **131 ms** | **701 KB** | **8.9 ms** |

¹ `JSON.parse` + revive, compared with the branch's faster `fromJSON`. Against
0.6.4's `fromJSON`, packed decodes about 4–5× faster.

Raw size shrinks about 3×, which is what memory and `JSON.parse` see. Compressed
size shrinks only 10–45%.

## 5. End to end

Per document, the way the portal uses Markdoc (`bench/e2e.mjs`):
- **build:** source → AST → validate → serialize;
- **runtime:** deserialize → transform with per-call variables → render;
- **embedded:** the API-docs case, where the AST arrives inside a parsed API
  definition.

| | 0.6.4 | same steps | fast path |
|---|---|---|---|
| pages — build | 789 ms | 430 ms (1.84×) | **363 ms (2.17×)** |
| pages — runtime → HTML | 679 ms | 431 ms (1.57×) | **184 ms (3.68×)** |
| pages — runtime → React | 684 ms | 432 ms (1.58×) | **198 ms (3.46×)** |
| pages — embedded → React | 724 ms | 487 ms (1.49×) | **158 ms (4.59×)** |
| descriptions — build | 177 ms | 102 ms (1.73×) | **52.7 ms (3.35×)** |
| descriptions — runtime → HTML | 115 ms | 89.4 ms (1.29×) | **39.0 ms (2.96×)** |
| descriptions — runtime → React | 118 ms | 88.8 ms (1.33×) | **31.2 ms (3.80×)** |
| descriptions — embedded → React | 124 ms | 92.8 ms (1.33×) | **22.0 ms (5.62×)** |

## 6. Rust and other engines

- **The WASM boundary eats the Rust speed.** comrak (Rust → WASM) turns pages
  into HTML in 114 ms, but handing JS a tree takes 454 ms. That's 2.5× slower
  than the new JS parser's 180 ms for a full Markdoc AST.
- **Markdoc needs a JS tree.** Validation, schemas and renderers are
  user-extensible JS, so a Rust core would trade parsing for serialization.
  **Not worth it.**
- **Don't upgrade markdown-it for speed:** 15.0 is 1.4–2× slower than 12.3.
  The question is moot now that markdown-it is gone.

## Moving Redocly over

The four parse sites become one call each:

```js
import { htmlTags } from '@redocly/markdoc/dist/html';

const OPTIONS = { html: htmlTags(), allowIndentation: true, allowComments: true };

// portal compiler.ts:  tokenizer + #996 patch + processHtmlTokens + parse
const ast = markdoc.parse(rawContent, { ...OPTIONS, file: relativePath, slots: true });
normalizeHtmlHeadings(ast); // unchanged

// realm-plus parse-cache.ts
Markdoc.parse(rawSource, { ...OPTIONS, slots: true });

// api-docs markdocParser.ts and markdoc-editor parser: same, with their own args
```

1. **Delete what's no longer needed.** That's the three
   `getRules('reference').length = 0` patches and the three
   `process-html-tokens.ts` copies. Remove the `htmlparser2` dependency
   wherever it was only there for them.
2. **Storage:** `Ast.pack(ast, { compact: true })`, behind a cache-version
   bump. Old JSON still loads with `fromJSON`.
3. **Runtime:**
   - `markdocRenderer.tsx`: `Ast.unpack(source)` instead of
     `fromJSON(JSON.stringify(source))`;
   - `runtime-transform.ts`: `prepareConfig(markdocOptions, { cloneAst: false })`
     once per process.
4. **Code that reads tokens has to change.** `realm-plus`'s `MarkdownToken`
   type and `markdoc-editor`'s `TokenizerInternals` use the removed API.

## Reproduce

```bash
npm install && npm run build
NODE_ENV=production node --expose-gc bench/ab.mjs             # stage A/B vs 0.6.4 (+ output identity check)
NODE_ENV=production node --expose-gc bench/e2e.mjs            # end-to-end paths
NODE_ENV=production node bench/exp-fastparse.mjs              # parser vs 0.6.4 on the corpus
NODE_ENV=production node bench/fuzz-fastparse.mjs 5000 1 random   # differential fuzzing (also: mutate)
node bench/exp-html.mjs                                        # htmlTags() vs Realm's processHtmlTokens
NODE_ENV=production node --expose-gc bench/exp-format.mjs     # storage formats
NODE_ENV=production node --expose-gc bench/exp-engines.mjs    # other engines (pages|descriptions)
```

The corpus and the Realm reference are read from `REDOCLY_REPO` (default
`~/Projects/redocly`) and cached in `bench/.cache/`.
