# Markdoc performance & AST size — experiment report

Branch `perf/fast-parser` (built on `perf/explore`), against the published
`@redocly/markdoc@0.6.4`. Every number below was measured on the real Redocly
content; raw outputs are in `bench/results/`.

## TL;DR

| | 0.6.4 | this branch, drop-in | this branch, opt-in fast path |
|---|---|---|---|
| **Build**, pages (parse → validate → serialize) | 793 ms | 648 ms (1.2×) | **355 ms (2.2×)** |
| **Build**, API descriptions | 174 ms | 158 ms (1.1×) | **50 ms (3.5×)** |
| **Runtime**, pages (deserialize → transform → React) | 667 ms | 419 ms (1.6×) | **186 ms (3.6×)** |
| **Runtime**, API descriptions | 117 ms | 88 ms (1.3×) | **31 ms (3.8×)** |
| **Runtime**, API descriptions embedded in a parsed API definition | 122 ms | 93 ms (1.3×) | **22 ms (5.5×)** |
| **Stored AST**, pages (6.66 MB of markdown) | 29.2 MB | 29.2 MB | **10.1 MB (2.9× smaller)** |
| **Stored AST**, API descriptions (0.49 MB) | 2.47 MB | 2.47 MB | **0.70 MB (3.5× smaller)** |

- **Drop-in** means the same calls as the portal makes today
  (`parse(tokenizer.tokenize(src))`, `fromJSON`, `transform`), with
  byte-identical output.
- **Opt-in fast path** means the new, backwards-compatible calls. Output is
  identical there too.
  - `parse(src, { tokenizer })` runs the new parser. Plain `parse(string)`
    gets it automatically.
  - `prepareConfig(config, { cloneAst: false })`.
  - `Ast.pack(ast, { compact: true })` to store, and `Ast.unpack(value)` to
    load.
- **A new parser, in TypeScript.** `src/fastparse` reimplements markdown-it
  12.3.2 plus Markdoc's plugins using mdastic's techniques.
  - It goes from source text straight to Markdoc Nodes.
  - It produces the identical AST 2.4× faster on pages and 4.2× faster on API
    descriptions, about as fast as mdastic and commonmark.js.
- **No Rust needed.** WASM engines lose their speed advantage as soon as they
  hand a tree to JS (details below).

## Setup

- **Corpus:**
  - 1,129 pages from `docs/realm`, `docs/intranet` and
    `packages/portal/playground` (6.66 MB);
  - 7,811 `description` strings from the Rebilly OpenAPI definition
    (0.49 MB, median 34 characters).
  - The corpus is cached in `bench/.cache/` (gitignored, never committed).
- **Config:** every custom tag the corpus uses, declaring every attribute
  it passes (47 custom tags). This gives the transformer the same per-node
  work as production, without the theme's React components.
- **Tokenizer settings:** pages use the portal's (`html`, `allowIndentation`,
  `allowComments`); descriptions use the defaults with `compact: true`.
- **Machine:** darwin, 11 cores, Node 24.21. The machine is shared and was
  heavily loaded (load average 12–57).
  - All timings are **process CPU time** (user+sys), not wall time.
  - Each figure is the median of interleaved rounds.
- **A/B runs** go through separate processes: each library build gets its own
  fresh process, and order alternates between rounds.
  - Two copies of Markdoc in one process made whichever was required *first*
    ~35% faster, even when the files were byte-identical. An earlier version
    of the harness was fooled by this.
  - An A/A run agrees within ~3%. Stages under 10 ms wobble by up to ~8%.
- **Correctness gate:** before any timing, `bench/ab.mjs` checks the branch
  against 0.6.4 on all 8,940 documents. Tokens, parsed AST (from tokens and
  from source), stored JSON, validation errors, renderable tree, HTML and
  React element tree must all be identical. The unit suite grew from 481 to
  504 specs, all passing.

## Where 0.6.4 spends its time

Pages, sum of all stages = 1.83 s:

| tokenize | parse | validate | compact+stringify | **revive** | transform | html | react |
|---|---|---|---|---|---|---|---|
| 19% | 9% | 16% | 9% | **28%** | 10% | 5% | 5% |

- Reviving the stored JSON costs more than tokenizing the markdown did.
  The cause is `JSON.parse(text, reviver)`: V8 calls the reviver for every
  string and number in the document and gives up its JSON fast path.
- For short API descriptions, **`mergeConfig` alone was 86% of
  `transform`**. Every `transform`/`validate` call spreads ~90 tag, node
  and function schemas into fresh objects.
- `transform` also deep-copies the whole AST first (`resolve`), even when
  the tree contains no variables or functions.
- Tokenizing is markdown-it's own block and inline rules, plus ~18% for
  Markdoc's plugins, plus a separate pass turning tokens into Nodes.

## 1. A new parser (`src/fastparse`)

The fastest JS markdown parsers are 2.5–3× quicker than markdown-it. The
reason is mostly their machinery rather than their grammar. So the new
parser keeps Markdoc's exact grammar and replaces only the machinery:

- **Same grammar:** markdown-it 12.3.2's block and inline rules, with
  Markdoc's indentation patch.
  - Markdoc's plugins: tags, annotations, comments, frontmatter, GitHub
    admonitions and link validation.
  - `parser.ts`'s token-to-Node logic, including its odd cases (stray
    closing tags, unclosed inline tags, errors on mismatches).
- **Machinery, as in mdastic:**
  - Line offsets live in typed arrays reused across documents, found with
    `indexOf('\n')`. markdown-it loops over every character.
  - Tokens are pooled objects reused across documents, not `new Token()`.
  - There is no separate tokens-to-AST pass: Nodes are built as tokens are
    consumed.
  - Rules are dispatched by first character, instead of trying each rule in
    turn.
  - Anchored regexes run sticky at the current position, instead of on a
    fresh `src.slice(pos)` copy per attempt.
- **Work Markdoc never reads is skipped.** Two examples:
  - Image labels are not re-parsed (an image is a leaf node in Markdoc).
  - The table transform doesn't walk documents that contain no `table` tag.
- markdown-it's pure link helpers (URL normalization) are memoized.

**Correctness**, compared with `parse(new Tokenizer(cfg).tokenize(src), args)`
(byte-identical AST JSON, or both throwing):

| check | result |
|---|---|
| all 8,940 corpus documents × 6 tokenizer/parser settings (26,000+ parses) | identical |
| unit suite with every `parse(string)` routed through the new parser | 504/504 pass |
| marktest suite, routed the same way | output identical |
| random documents from markdown edge-case fragments (5,000 × 5 settings, plus a longer run stopped after 30 CPU-minutes) | 0 mismatches |
| real corpus documents mutated (lines dropped, duplicated, re-indented, characters spliced; 6,300 × 5 settings) | 0 mismatches |

**Speed**, source text → AST, each engine in its own process (`bench/exp-engines.mjs`):

| | pages | vs 0.6.4 | descriptions | vs 0.6.4 |
|---|---|---|---|---|
| markdoc 0.6.4: markdown-it tokens + parse | 428 ms | 1.00× | 77.9 ms | 1.00× |
| this branch: markdown-it tokens + parse | 376 ms | 1.14× | 67.9 ms | 1.15× |
| **this branch: new parser** | **176 ms** | **2.43×** | **18.7 ms** | **4.17×** |
| mdastic 0.1 (mdast, no Markdoc tags) | 153–163 ms | 2.6–2.8× | 14.2–14.6 ms | 5.3–5.5× |
| commonmark.js 0.31 (no tables, no Markdoc tags) | 166 ms | 2.57× | 30.8 ms | 2.53× |

The new parser is now in the same class as the fastest JS engines. It also
does more work than they do: Markdoc tags and annotations, and a `location`
object (three allocations) on every node.

**API:**
- `parse(string)` uses the new parser by default.
- `parse(source, { tokenizer: config })` takes the same settings as
  `new Tokenizer(config)`.
- Passing tokens (`parse(tokenizer.tokenize(src))`) still goes through
  markdown-it. It's the escape hatch, and the `Tokenizer` API (`stopAfter`,
  `tokenizeUntil`, token consumers) is unchanged.
- String parses whose tokenizer settings use options the new parser does not
  implement (`linkify`, `typographer`, a non-default `maxNesting`) fall back
  to markdown-it automatically.

**Costs:**
- The bundle ships both parsers: 68 KB → 87 KB gzipped (this includes the
  rest of this branch's work).
- A markdown-it upgrade or a new Markdoc tokenizer plugin now has to be
  ported to `src/fastparse`. `bench/exp-fastparse.mjs` and
  `bench/fuzz-fastparse.mjs` are there to catch drift.
- One markdown-it quirk is deliberately not reproduced. At inline nesting
  depth ≥ 100, markdown-it reuses a stale "rule matched" flag and can loop
  forever; the new parser just stops matching rules there.

## 2. Other drop-in changes (same API, byte-identical output)

Stage by stage. Timings come from one worker process per build, which runs
every stage over the whole corpus.

| stage | pages 0.6.4 | pages branch | | descriptions 0.6.4 | descriptions branch | |
|---|---|---|---|---|---|---|
| **source → AST** (0.6.4: tokens + parse; branch: new parser) | 463 ms | 216 ms | **2.14×** | 60.8 ms | 22.6 ms | **2.70×** |
| tokenize (markdown-it tokens)¹ | 364 ms | 395 ms | 0.92× | 48.4 ms | 56.2 ms | 0.86× |
| parse (tokens → AST) | 153 ms | 120 ms | **1.27×** | 12.6 ms | 9.55 ms | 1.32× |
| validate | 284 ms | 196 ms | **1.45×** | 72.7 ms | 65.1 ms | 1.12× |
| compact + stringify | 158 ms | 154 ms | 1.03× | 14.9 ms | 15.3 ms | 0.98× |
| revive (`fromJSON`) | 510 ms | 268 ms | **1.91×** | 44.1 ms | 16.4 ms | **2.68×** |
| transform | 192 ms | 159 ms | 1.21× | 65.4 ms | 56.9 ms | 1.15× |
| render html | 85.6 ms | 75.1 ms | 1.14× | 6.03 ms | 1.06 ms | **5.69×** |
| render react | 83.0 ms | 84.2 ms | 0.99× | 6.79 ms | 7.09 ms | 0.96× |

¹ Not a regression in the tokenizer itself. Timed alone, in a process
running only that stage, the branch tokenizes in 376 ms against 375 ms for
the pre-parser build. In the full worker, the branch's `source → AST` stage
runs the new parser, so markdown-it's code is colder there than in 0.6.4's
worker, which runs markdown-it in both stages.

What changed:

- **`Ast.fromJSON`:** plain `JSON.parse`, then one bottom-up walk that turns
  `$$mdtype` objects into class instances. Same result as the reviver.
- **`Node.walk()`:** iterative instead of one nested generator per ancestor.
  Children are still read lazily, so replacing `node.children` mid-walk
  behaves as before.
- **`validate`:**
  - no generator;
  - one `parents` array and config per *parent*, not per node;
  - nodes and configs are collected into flat arrays;
  - no per-node temporaries (merged attribute schemas, mapped empty error
    lists).
- **`transform`:**
  - attributes are visited in merged order without building the merged
    object;
  - the stateless built-in attribute types are instantiated once.
- **Token parser:** no regex per token, no array allocated per token.
- **Tag helpers:** `findTagEnd` compares character codes; `parseTags`
  returns early for fence content without tags.
- **HTML renderer:** appends into one string instead of `map(render).join('')`
  at every level.

## 3. Opt-in APIs (identical output, new calls)

### `Markdoc.prepareConfig(config)`

This merges the built-in tags, nodes and functions once.

- The result carries an enumerable symbol brand, so the portal's
  `{ ...markdocOptions, ...config, variables }` spread keeps it prepared.
- It is reused only while `tags`, `nodes` and `functions` are still the very
  objects that were merged. Replacing one of them merges as usual.
- The catch: it is a snapshot. Tags added *in place* afterwards are not seen,
  which is why this is opt-in rather than automatic.

| | pages | descriptions |
|---|---|---|
| validate (vs 0.6.4) | 284 → 196 ms (1.45×) | 72.7 → **24.3 ms (2.99×)** |
| transform (vs 0.6.4) | 192 → 153 ms (1.26×) | 65.4 → **23.6 ms (2.77×)** |

I also measured automatic caches:
- A cache keyed by object identity *with* an exact staleness check only
  reached 1.4×, because checking ~90 keys costs about as much as copying
  them.
- Without the check it reached 3.4×, but it would silently miss in-place
  mutations.

### `prepareConfig(config, { cloneAst: false })`

`transform` normally deep-copies the whole AST before transforming it. With
this flag it copies only the nodes on the way to a variable or function, and
hands every other node to schema transforms as-is.

- Output is identical.
- The difference is only visible to a schema transform that *mutates* the
  node it is given: that change then lands in the input AST.
- None of Markdoc's built-in schemas do that, and neither do Redocly's
  runtime schemas. The only node mutation in the portal is a build-time
  attribute resolver that runs before storage.

On pages, with a prepared config, this takes transform from 155 to 121 ms
(1.28× more).

### `Ast.pack(ast, { compact: true })` / `Ast.unpack(value)` — the AST representation

What a stored page AST is made of today (29.2 MB for 6.66 MB of markdown,
108 bytes per node):

| | share |
|---|---|
| actual text content | 22% |
| `"$$mdtype":"Node"` on every node | 17% |
| `"attributes":{}` | 15% |
| `"type":…` | 14% |
| `"children":[]` | 14% |
| `"inline":true` | 8% |
| attribute keys | 7% |

Text nodes are 44% of all nodes (118k of 270k), and each one carries that
whole envelope.

The packed format is still plain JSON, so it can live inside any JSON
document:

```js
// "Hello *world*"   →   ["paragraph", "Hello ", ["~em", {"marker":"*"}, "world"]]
```

- **Nodes:** `[head, attributes?, ...children]`, recognized by position, so
  no `$$mdtype`.
- **Head:** the node type, or `%name` for a tag, with a `~` prefix when the
  node is inline.
- **Plain inline text:** just its string.
- **Rare fields** (errors, annotations, slots, location, an odd tag) go
  under `$`-keys in the attributes object. Those can never clash with real
  attributes, because attribute names are identifiers.
- **Lossless:** `unpack(pack(ast))` serializes exactly like
  `fromJSON(JSON.stringify(ast))`, checked on every corpus document and in
  unit tests.
- **No input mutation:** `unpack` takes the already-parsed value and never
  mutates it.
- **Fused compaction:** `pack(ast, { compact: true })` applies `compact()` in
  the same pass. Serializing a page AST drops from 158 to 99 ms (1.6×).

| format | pages raw | gzip | brotli | decode¹ | descriptions raw | gzip | brotli | decode¹ |
|---|---|---|---|---|---|---|---|---|
| compact JSON (today) | 29.18 MB | 3.10 MB | 2.80 MB | 270 ms | 2.47 MB | 1.26 MB | 1.01 MB | 32.8 ms |
| lean JSON (objects, defaults omitted) | 16.03 MB | 2.86 MB | 2.65 MB | 142 ms | 1.25 MB | 963 KB | 789 KB | 12.6 ms |
| **packed** | **10.14 MB** | 2.70 MB | 2.51 MB | **131 ms** | **701 KB** | 693 KB | 533 KB | **8.9 ms** |
| packed + 1-letter type codes | 9.51 MB | 2.66 MB | 2.47 MB | 131 ms | 610 KB | 631 KB | 473 KB | 8.9 ms |

¹ `JSON.parse` + revive to `Node`s, versus *this branch's* already 1.9× faster
`fromJSON`. Against 0.6.4's `fromJSON` (510 / 44.1 ms), packed decodes
**3.9× / 5.0× faster**. gzip/brotli are per document.

- **Raw size** shrinks about 3×. That is what lands in memory, JSON caches
  and `JSON.parse`.
- **Compressed size** only shrinks 10–45%, since gzip already removes most
  of the repetition. Packed is not mainly a network win.
- **Single-letter type codes** save little compressed and cost readability.
  Not worth it.

## 4. End to end

Per document, the way the portal uses Markdoc (`bench/e2e.mjs`):

- **build:** source → AST → validate → compact → stringify.
- **runtime:** deserialize → transform with per-call variables → render.
- **embedded:** the API-docs case, where the AST arrives as an already-parsed
  object inside the API definition. Today `markdocRenderer.tsx` does
  `fromJSON(JSON.stringify(source))`; the fast path calls `unpack(source)`.

| | 0.6.4 | drop-in | fast path |
|---|---|---|---|
| pages — build | 793 ms | 648 ms (1.22×) | **355 ms (2.23×)** |
| pages — runtime → HTML | 653 ms | 419 ms (1.56×) | **183 ms (3.57×)** |
| pages — runtime → React | 667 ms | 419 ms (1.59×) | **186 ms (3.59×)** |
| pages — embedded → React | 704 ms | 477 ms (1.48×) | **157 ms (4.47×)** |
| descriptions — build | 174 ms | 158 ms (1.10×) | **49.9 ms (3.48×)** |
| descriptions — runtime → HTML | 116 ms | 90.0 ms (1.29×) | **38.9 ms (2.98×)** |
| descriptions — runtime → React | 117 ms | 88.0 ms (1.33×) | **30.8 ms (3.80×)** |
| descriptions — embedded → React | 122 ms | 93.0 ms (1.31×) | **22.1 ms (5.53×)** |

The fast build is `parse(src, { tokenizer })`, then validate with a prepared
config, then `pack(ast, { compact: true })`. Build numbers vary the most
between runs: 0.6.4's page build measured 793–965 ms across runs.

End-to-end numbers come out lower than the sum of the stage table. Here each
document's AST is garbage as soon as it is done, which keeps garbage
collection cheap; the stage runs keep the whole corpus's ASTs alive.

## 5. Other engines, and Rust

Each engine ran in its own process, on the same pages, with the portal's
tokenizer settings. None of them understands `{% tag %}` syntax.

| engine | output | pages | vs 0.6.4 | descriptions² | vs 0.6.4 |
|---|---|---|---|---|---|
| markdoc 0.6.4 — tokens + parse | tree | 428 ms | 1.00× | 77.9 ms | 1.00× |
| **markdoc branch — new parser** | tree | **176 ms** | **2.43×** | **18.7 ms** | **4.17×** |
| markdown-it 12.3 (what Markdoc uses), no Markdoc plugins | tokens | 246 ms | 1.74× | 30.9 ms | 2.52× |
| markdown-it 15.0, no plugins | tokens | 362 ms | 1.18× | 51.4 ms | 1.52× |
| marked 18 — lexer | tokens | 271 ms | 1.58× | 20.9 ms | 3.73× |
| mdastic 0.1 (GFM, mdast out) | tree | 153–163 ms | 2.6–2.8× | 14.2–14.6 ms | 5.3–5.5× |
| commonmark.js 0.31 (no GFM tables) | tree | 166 ms | 2.57× | 30.8 ms | 2.53× |
| remark (`mdast-util-from-markdown` 2) | tree | 2430 ms | 0.18× | 259 ms | 0.30× |
| **comrak 0.48, Rust → WASM, parse to JS tree** | tree | **443 ms** | **0.96×** | 84.0 ms | 0.93× |
| comrak 0.48, Rust → WASM, straight to HTML | html | 115 ms | 3.7× | 55.1 ms | 1.4× |
| pulldown-cmark, Rust → WASM, to HTML | html | 97 ms | 4.4× | 23.5 ms | 3.3× |
| md4c, C → WASM (`markdown-wasm`), to HTML | html | 48 ms | 9.0× | 27.0 ms | 2.9× |

² Descriptions here use the page tokenizer settings and no compact mode.

- **The boundary eats the Rust speed.**
  - comrak's Rust core turns pages into HTML in 115 ms. Asking it for a JS
    tree costs 443 ms, slower than the new JS parser's 176 ms for a full
    Markdoc AST.
  - Validation, schema transforms and renderers are user-extensible JS, so
    Markdoc needs a JS tree. A WASM core would trade parsing for
    serialization.
- **A Rust parser emitting the packed format as a string** would still pay
  `JSON.parse` + `unpack` (131 ms on pages) on top of its own parse time.
  That's no better than the 176 ms the JS parser takes now. **Not worth it.**
- **Do not upgrade markdown-it for speed:** 15.0 is 1.5× slower than 12.3.

## Tried and dropped

- **Hand-written loop instead of `flatMap` in `transformer.children`:** 9%
  *slower* on pages. Reverted.
- **Restructured `Node.resolve` / `base.resolve` clone:** no measurable
  change. Reverted.
- **One-pass props in the React renderer:** 0–15% slower. React rendering is
  bound by `React.createElement` itself.
- **Exact-semantics automatic `mergeConfig` cache:** 1.4×, against 3.0× for
  the opt-in `prepareConfig`.
- **Single-letter type codes in the packed format:** not worth the
  readability.

## Next steps

1. **Adopt in Redocly.** Four changes bring most of the gain:
   - **Build:** `markdoc.parse(src, { ...args, tokenizer: tokenizerOptions })`
     instead of `markdoc.parse(tokenizer.tokenize(src), args)`.
   - **Storage:** `pack(ast, { compact: true })` behind a cache-version bump.
     Old JSON stays readable through `fromJSON`.
   - **`markdocRenderer.tsx`:** `unpack(source)` instead of
     `fromJSON(JSON.stringify(source))`.
   - **`runtime-transform.ts`:** `prepareConfig(markdocOptions, { cloneAst: false })`
     once per process.
2. **Release plan for the parser.** It is the default for `parse(string)` on
   this branch. A more cautious rollout would ship it opt-in for a release
   first, behind `parse(src, { tokenizer })` only.
3. **Build-time parallelism.** Pages are independent, so `worker_threads`
   should scale close to linearly with cores. Not measured, because the
   shared machine was too loaded for wall-clock numbers.
4. **The remaining build cost** is mostly validate (~200 ms on pages, about
   0.7 µs per node), then the parser.

## Reproduce

```bash
npm install && npm run build
NODE_ENV=production node --expose-gc bench/ab.mjs             # stage A/B vs 0.6.4 (+ output identity check)
NODE_ENV=production node --expose-gc bench/e2e.mjs            # end-to-end paths
NODE_ENV=production node --expose-gc bench/exp-fastparse.mjs  # new parser: corpus identity check + timing
NODE_ENV=production node bench/fuzz-fastparse.mjs 5000 1 random   # differential fuzzing
NODE_ENV=production node bench/fuzz-fastparse.mjs 5000 1 mutate
NODE_ENV=production node --expose-gc bench/exp-format.mjs     # storage formats
NODE_ENV=production node --expose-gc bench/exp-engines.mjs    # other engines (pages|descriptions)
NODE_ENV=production node bench/profile.mjs fastparse pages candidate   # CPU profile of one stage
```

The corpus is read from `REDOCLY_REPO` (default `~/Projects/redocly`) and
cached in `bench/.cache/`.
