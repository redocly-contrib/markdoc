# Markdoc performance & AST size — experiment report

Branch `perf/explore`, against the published `@redocly/markdoc@0.6.4`.
Every number below was measured on the real Redocly content; raw outputs are
in `bench/results/`.

## TL;DR

| | 0.6.4 | this branch, drop-in | this branch, opt-in fast path |
|---|---|---|---|
| **Runtime**, pages (deserialize → transform → React) | 665 ms | 475 ms (1.4×) | **192 ms (3.5×)** |
| **Runtime**, API descriptions | 131 ms | 85 ms (1.5×) | **32 ms (4.1×)** |
| **Runtime**, API descriptions embedded in a parsed API definition | 125 ms | 90 ms (1.4×) | **22 ms (5.7×)** |
| **Build**, pages (parse → validate → serialize) | 794 ms | 693 ms (1.15×) | 632 ms (1.26×) |
| **Build**, API descriptions | 181 ms | 167 ms (1.08×) | 121 ms (1.5×) |
| **Stored AST**, pages (6.66 MB of markdown) | 29.2 MB | 29.2 MB | **10.1 MB (2.9× smaller)** |
| **Stored AST**, API descriptions (0.49 MB) | 2.47 MB | 2.47 MB | **0.70 MB (3.5× smaller)** |

- **Drop-in** means the same API calls as today, with byte-identical output.
- **Opt-in** means three new, backwards-compatible APIs:
  `prepareConfig(config, { cloneAst: false })`, `Ast.pack(ast, { compact: true })`
  for storage, and `Ast.unpack(value)` to load. Output is identical there too.
- **Nothing here needs Rust or a different engine.**
  - The biggest costs were not in markdown parsing. They were in reviving
    JSON, re-merging the config on every call, and copying the whole tree
    before each transform.
  - WASM engines lose their speed advantage as soon as they hand a tree to
    JS (details below).

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
- **Machine:** darwin, 11 cores, Node 24.21. The machine is shared and was
  heavily loaded (load average 12–57).
  - All timings are **process CPU time** (user+sys), not wall time.
  - Each figure is the median of interleaved rounds.
- **A/B runs** go through separate processes: each library build gets its own
  fresh process, and order alternates between rounds.
  - Loading two copies of Markdoc into one process made whichever was
    required *first* ~35% faster on transform and validate, even when the
    two files were byte-identical. An earlier version of the harness was
    fooled by this.
  - An A/A run of the fixed harness agrees within ~3%. Small stages
    (< 10 ms) wobble by up to ~8%.
- **Correctness gate:** before any timing, `bench/ab.mjs` checks the branch
  against 0.6.4 on all 8,940 documents. Tokens, parsed AST, stored JSON,
  validation errors, renderable tree, HTML and React element tree must all be
  identical. The unit suite grew from 481 to 501 specs, all passing.

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

## 1. Drop-in changes (same API, byte-identical output)

| stage | pages 0.6.4 | pages branch | | descriptions 0.6.4 | descriptions branch | |
|---|---|---|---|---|---|---|
| tokenize | 359 ms | 357 ms | 1.01× | 51.4 ms | 51.2 ms | 1.00× |
| parse | 156 ms | 118 ms | **1.32×** | 13.9 ms | 11.7 ms | 1.20× |
| validate | 287 ms | 226 ms | **1.27×** | 74.4 ms | 72.7 ms | 1.02× |
| compact + stringify | 158 ms | 157 ms | 1.01× | 15.8 ms | 15.3 ms | 1.03× |
| revive (`fromJSON`) | 513 ms | 270 ms | **1.90×** | 45.6 ms | 17.0 ms | **2.69×** |
| transform | 190 ms | 160 ms | 1.18× | 66.9 ms | 59.1 ms | 1.13× |
| render html | 86.1 ms | 74.4 ms | 1.16× | 6.09 ms | 1.11 ms | **5.50×** |
| render react | 83.5 ms | 82.9 ms | 1.01× | 7.06 ms | 7.17 ms | 0.99× |
| **sum** | **1833 ms** | **1445 ms** | **1.27×** | **281 ms** | **235 ms** | **1.20×** |

What changed:

- **`Ast.fromJSON`:** plain `JSON.parse`, then one walk that turns
  `$$mdtype` objects into class instances bottom-up. Same result as the
  reviver.
- **`Node.walk()`:** iterative instead of one nested generator per ancestor.
  - The table transform walks every parsed document with it, so parse
    pays for this whether or not a page has tables.
  - Children are still read lazily, after the consumer has seen the parent,
    so replacing `node.children` mid-walk behaves as before.
- **`validate`:**
  - no generator;
  - one `parents` array and one per-node config per *parent*, not per node;
  - no merged `{...globalAttributes, ...schema.attributes}` object per node.
- **`transform`:**
  - attributes are visited in the merged order without building the merged
    object;
  - stateless built-in attribute types (`Class`, `Id`, `String`, …) are
    instantiated once. Custom types are still constructed per use.
- **Parser:** no regex per token (`_open`/`_close` suffix), no array
  allocated per token for an `includes` check.
- **HTML renderer:** appends into one string instead of `map(render).join('')`
  at every level.

## 2. Opt-in APIs (identical output, new calls)

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
| validate (vs 0.6.4) | 287 → 222 ms (1.29×) | 74.4 → **30.8 ms (2.41×)** |
| transform (vs 0.6.4) | 190 → 156 ms (1.21×) | 66.9 → **22.3 ms (3.00×)** |

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
  `fromJSON(JSON.stringify(ast))`. This is checked on all 8,940 corpus
  documents and in unit tests, including errors, slots, annotations,
  variables, functions, and hand-built `$`-named attributes.
- **No input mutation:** `unpack` takes the already-parsed value and never
  mutates it.

| format | pages raw | gzip | brotli | decode¹ | descriptions raw | gzip | brotli | decode¹ |
|---|---|---|---|---|---|---|---|---|
| compact JSON (today) | 29.18 MB | 3.10 MB | 2.80 MB | 270 ms | 2.47 MB | 1.26 MB | 1.01 MB | 32.8 ms |
| lean JSON (objects, defaults omitted) | 16.03 MB | 2.86 MB | 2.65 MB | 142 ms | 1.25 MB | 963 KB | 789 KB | 12.6 ms |
| **packed** | **10.14 MB** | 2.70 MB | 2.51 MB | **131 ms** | **701 KB** | 693 KB | 533 KB | **8.9 ms** |
| packed + 1-letter type codes | 9.51 MB | 2.66 MB | 2.47 MB | 131 ms | 610 KB | 631 KB | 473 KB | 8.9 ms |

¹ `JSON.parse` + revive to `Node`s, versus *this branch's* already 1.9× faster
`fromJSON`. Against 0.6.4's `fromJSON` (513 ms / 45.6 ms), packed decodes
**3.9× / 5.1× faster**. gzip/brotli are per document.

- **Raw size** shrinks about 3×. That is what lands in memory, JSON caches
  and `JSON.parse`.
- **Compressed size** only shrinks 10–45%, since gzip already removes most
  of the repetition. Packed is not mainly a network win.
- **Single-letter type codes** save another 6–13% raw but under 2%
  compressed, at a real cost in readability. Not worth it.
- **Fused compaction:** `pack(ast, { compact: true })` applies `compact()`
  in the same pass, without building the intermediate tree. Serializing a
  page AST drops from 158 to 99 ms (1.6×).

## 3. End to end

Per document, the way the portal uses Markdoc (`bench/e2e.mjs`):

- **build:** tokenize + parse → validate → compact → stringify.
- **runtime:** deserialize → transform with per-call variables → render.
- **embedded:** the API-docs case, where the AST arrives as an already-parsed
  object inside the API definition. Today `markdocRenderer.tsx` does
  `fromJSON(JSON.stringify(source))`; the fast path calls `unpack(source)`.

| | 0.6.4 | drop-in | fast path |
|---|---|---|---|
| pages — build | 794 ms | 693 ms (1.15×) | 632 ms (1.26×) |
| pages — runtime → HTML | 661 ms | 424 ms (1.56×) | **187 ms (3.53×)** |
| pages — runtime → React | 665 ms | 475 ms (1.40×) | **192 ms (3.46×)** |
| pages — embedded → React | 739 ms | 487 ms (1.52×) | **161 ms (4.59×)** |
| descriptions — build | 181 ms | 167 ms (1.08×) | 121 ms (1.49×) |
| descriptions — runtime → HTML | 116 ms | 91.6 ms (1.27×) | **32.4 ms (3.60×)** |
| descriptions — runtime → React | 131 ms | 85.2 ms (1.53×) | **31.9 ms (4.10×)** |
| descriptions — embedded → React | 125 ms | 89.5 ms (1.40×) | **21.9 ms (5.72×)** |

Build numbers are the noisiest: 0.6.4's page build measured 794 ms in this
run and 965 ms in an earlier one, while drop-in measured 693–696 ms in both.

## 4. Other engines, and Rust

Each engine below ran in its own process, on the same pages, with the
portal's tokenizer settings. **None of them understands `{% tag %}`
syntax**, so these are upper bounds for the CommonMark core only.

| engine | output | pages | vs 0.6.4 | descriptions² | vs 0.6.4 |
|---|---|---|---|---|---|
| markdoc 0.6.4 — tokenize+parse | tree | 452 ms | 1.00× | 78.3 ms | 1.00× |
| markdoc branch — tokenize+parse | tree | 392 ms | 1.15× | 69.8 ms | 1.12× |
| markdoc branch — tokenize only | tokens | 296 ms | 1.53× | 34.1 ms | 2.30× |
| markdown-it 12.3 (what Markdoc uses), no Markdoc plugins | tokens | 250 ms | 1.81× | 25.3 ms | 3.10× |
| markdown-it 15.0, no plugins | tokens | 377 ms | 1.20× | 54.5 ms | 1.44× |
| marked 18 — lexer | tokens | 326 ms | 1.39× | 20.8 ms | 3.76× |
| **mdastic 0.1** (GFM, mdast out) | tree | **168–201 ms** | **2.3–2.7×** | **24 ms** | **3.3×** |
| **commonmark.js 0.31** (no GFM tables) | tree | **144 ms** | **3.1×** | 38.2 ms | 2.1× |
| remark (`mdast-util-from-markdown` 2) | tree | 2304 ms | 0.20× | 287 ms | 0.27× |
| **comrak 0.48 (Rust → WASM) — parse to JS tree** | tree | **450 ms** | **1.00×** | 87.0 ms | 0.90× |
| comrak 0.48 (Rust → WASM) — straight to HTML | html | 117 ms | 3.9× | 55.2 ms | 1.4× |
| pulldown-cmark (Rust → WASM) — to HTML | html | 98 ms | 4.6× | 30.8 ms | 2.5× |
| md4c (C → WASM, `markdown-wasm`) — to HTML | html | 48 ms | 9.3× | 24.0 ms | 3.3× |
| markdown-it 15 / marked 18 / micromark 4 — to HTML | html | 400 / 395 / 2402 ms | | 67 / 44 / 300 ms | |

² Descriptions here use the page tokenizer settings and no compact mode, so
they don't line up with the stage tables above.

What this says:

- **The boundary eats the Rust speed.**
  - comrak's Rust core turns pages into HTML in 117 ms. Asking it for a tree
    JS can work with costs 450 ms, the same as Markdoc's whole JS
    tokenize+parse.
  - Markdoc needs a JS tree: validation, schema transforms and the
    renderers are all JS and user-extensible. So a WASM core would mostly
    trade parsing for serialization.
  - On short API descriptions, the per-call WASM overhead makes even the
    HTML path barely faster.
- **The best plausible Rust design** has the Rust side emit the packed format
  as a string, then JS does `JSON.parse` + `unpack`.
  - Estimate for pages: ~100–120 ms in Rust (the comrak/pulldown HTML
    times) plus 131 ms to decode ≈ 230–250 ms, versus 392 ms today.
  - That's about 1.6× on the parse step alone, which is roughly a quarter
    of build time.
  - It would mean reimplementing the Markdoc tag grammar, annotations, the
    `allowIndentation` patch, admonitions, comments, frontmatter and
    `stopAfter` with exact markdown-it compatibility. I didn't build it:
    **not worth it for the payoff**.
- **A faster JS core exists.**
  - mdastic is 2.3–3.3× faster than 0.6.4's tokenize+parse and supports GFM;
    commonmark.js is 3.1× on pages but has no tables.
  - Rebuilding Markdoc on one of them is the same compatibility project as
    above, for at most ~2× on about a quarter of build time.
  - Markdoc's own plugins cost ~18% on top of markdown-it core (296 vs
    250 ms).
- **Do not upgrade markdown-it for speed:** 15.0 is 1.5× slower than 12.3 on
  pages, and 2.2× slower on descriptions.

## Tried and dropped

- **Hand-written loop instead of `flatMap` in `transformer.children`:** 9%
  *slower* on pages. Reverted.
- **Restructured `Node.resolve` / `base.resolve` clone:** no measurable
  change. Reverted.
- **One-pass props in the React renderer:** 0–15% slower. React rendering is
  bound by `React.createElement` itself; the renderer is unchanged.
- **Exact-semantics automatic `mergeConfig` cache:** 1.4×, against 3.0× for
  the opt-in `prepareConfig` (see above).
- **Single-letter type codes in the packed format:** not worth the
  readability (see above).

## Not done yet (ideas with expected value)

1. **Adopt the opt-in APIs in Redocly.** This is where most of the measured
   wins come from:
   - `markdocRenderer.tsx`: `unpack(source)` instead of
     `fromJSON(JSON.stringify(source))`;
   - `runtime-transform.ts`: `prepareConfig(markdocOptions, { cloneAst: false })`
     once per process;
   - storage: `pack(ast, { compact: true })`.
   - Existing stored JSON stays readable via `fromJSON`, so the packed format
     can roll out behind a cache-version bump.
2. **Transform straight from the packed form.** This would skip building
   `Node`s for subtrees with no custom `transform`. The upper bound measured
   with a prepared config and no clone at all is 108 ms, against 121 ms with
   sharing: a small remaining gain for a lot of complexity.
3. **Build-time parallelism.** Pages are independent, so `worker_threads`
   should scale close to linearly with cores for tokenize, parse and
   validate. Not measured, because the shared machine was too loaded for
   meaningful wall-clock numbers.
4. **Tokenizer.** It is now the largest build-time stage (357 ms on pages).
   What's left is markdown-it's own block and inline rules plus ~18% in
   Markdoc plugins. Real gains need a parser rewrite (see the engines
   section).

## Reproduce

```bash
npm install && npm run build
NODE_ENV=production node --expose-gc bench/ab.mjs             # stage A/B vs 0.6.4 (+ output identity check)
NODE_ENV=production node --expose-gc bench/e2e.mjs            # end-to-end paths
NODE_ENV=production node --expose-gc bench/exp-format.mjs     # storage formats
NODE_ENV=production node --expose-gc bench/exp-engines.mjs    # other engines (pages|descriptions)
NODE_ENV=production node bench/profile.mjs transform pages candidate   # CPU profile of one stage
```

The corpus is read from `REDOCLY_REPO` (default `~/Projects/redocly`) and
cached in `bench/.cache/`.
