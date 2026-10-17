// End to end, per document, the way the portal uses Markdoc:
//
//   build    tokenize+parse -> validate -> compact -> serialize to a string
//   runtime  deserialize -> transform (per-call variables) -> render
//   embedded the API-docs case: the stored AST arrives as an already-parsed
//            object inside a bigger JSON document, then transform + render
//
// Three setups:
//   0.6.4     the published baseline
//   drop-in   this branch, same calls as 0.6.4 (byte-identical output)
//   fast      this branch with the opt-in APIs: prepareConfig (once, with
//             cloneAst: false), Ast.pack for storage, Ast.unpack to load
//
//   NODE_ENV=production node --expose-gc bench/e2e.mjs [rounds]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMarkdoc, React, CORPORA } from './lib/pipeline.mjs';
import { loadCorpus } from './lib/corpus.mjs';
import { buildConfig, buildComponents } from './lib/config.mjs';
import { compare, fmtMs, fmtBytes, summarize } from './lib/harness.mjs';

const self = fileURLToPath(import.meta.url);

function scenarios(M, corpusName) {
  const corpus = loadCorpus();
  const spec = CORPORA[corpusName];
  const sources = spec.sources(corpus);
  const config = buildConfig(M, corpus.pages);
  const components = buildComponents(config);
  const tk = spec.tokenizer(M);
  const parseArgs = spec.parseArgs;
  const fast = !!M.Ast.pack;
  const prepared = fast ? M.prepareConfig(config, { cloneAst: false }) : undefined;

  const parse = (s) => M.parse(tk.tokenize(s), parseArgs);
  const asts = sources.map(parse);
  const json = asts.map((a) => JSON.stringify(M.compact(a)));
  const objects = json.map((j) => JSON.parse(j));
  const packedText = fast ? asts.map((a) => JSON.stringify(M.Ast.pack(a, { compact: true }))) : [];
  const packedObjects = packedText.map((t) => JSON.parse(t));
  const vars = () => ({ name: 'x' });

  const out = {
    build: () => {
      for (const s of sources) {
        const ast = parse(s);
        M.validate(ast, config);
        JSON.stringify(M.compact(ast));
      }
    },
    'runtime html': () => {
      for (const j of json)
        M.renderers.html(M.transform(M.Ast.fromJSON(j), { ...config, variables: vars() }));
    },
    'runtime react': () => {
      for (const j of json)
        M.renderers.react(M.transform(M.Ast.fromJSON(j), { ...config, variables: vars() }), React, { components });
    },
    'embedded react': () => {
      // What api-docs does today: re-stringify the object to revive it.
      for (const o of objects)
        M.renderers.react(
          M.transform(M.Ast.fromJSON(JSON.stringify(o)), { ...config, variables: vars() }),
          React,
          { components }
        );
    },
  };
  if (fast) {
    Object.assign(out, {
      'build (fast)': () => {
        for (const s of sources) {
          const ast = M.parse(s, { ...parseArgs, tokenizer: spec.config });
          M.validate(ast, { ...prepared, variables: {} });
          JSON.stringify(M.Ast.pack(ast, { compact: true }));
        }
      },
      'runtime html (fast)': () => {
        for (const t of packedText)
          M.renderers.html(M.transform(M.Ast.unpack(JSON.parse(t)), { ...prepared, variables: vars() }));
      },
      'runtime react (fast)': () => {
        for (const t of packedText)
          M.renderers.react(M.transform(M.Ast.unpack(JSON.parse(t)), { ...prepared, variables: vars() }), React, { components });
      },
      'embedded react (fast)': () => {
        for (const o of packedObjects)
          M.renderers.react(M.transform(M.Ast.unpack(o), { ...prepared, variables: vars() }), React, { components });
      },
    });
  }
  const bytes = {
    json: json.reduce((n, j) => n + j.length, 0),
    packed: packedText.reduce((n, j) => n + j.length, 0),
  };
  return { run: out, bytes, docs: sources.length, check: () => {
    // fast must produce exactly what drop-in produces.
    if (!fast) return;
    for (let i = 0; i < json.length; i++) {
      const a = M.renderers.html(M.transform(M.Ast.fromJSON(json[i]), { ...config, variables: vars() }));
      const b = M.renderers.html(M.transform(M.Ast.unpack(JSON.parse(packedText[i])), { ...prepared, variables: vars() }));
      if (a !== b) throw new Error(`fast path output differs on doc #${i}`);
    }
  } };
}

const [, , mode, which, corpusName] = process.argv;
if (mode === 'worker') {
  const s = scenarios(loadMarkdoc(which), corpusName);
  s.check();
  const r = compare(s.run, { rounds: 5, warmup: 2 });
  process.stdout.write(JSON.stringify({
    docs: s.docs,
    bytes: s.bytes,
    ms: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.cpu.median])),
  }));
} else {
  const rounds = Number(mode || 3);
  const results = {};
  for (const corpus of ['pages', 'descriptions']) {
    const runs = { baseline: [], candidate: [] };
    for (let r = 0; r < rounds; r++)
      for (const w of r % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const p = spawnSync(process.execPath, ['--expose-gc', self, 'worker', w, corpus], {
          encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, NODE_ENV: 'production' },
        });
        if (p.status !== 0) throw new Error(p.stderr);
        runs[w].push(JSON.parse(p.stdout));
      }
    const med = (w, k) => summarize(runs[w].map((x) => x.ms[k])).median;
    const rows = ['build', 'runtime html', 'runtime react', 'embedded react'].map((k) => ({
      stage: k,
      baseline: med('baseline', k),
      dropIn: med('candidate', k),
      fast: med('candidate', `${k} (fast)`),
    }));
    results[corpus] = { docs: runs.baseline[0].docs, bytes: runs.candidate[0].bytes, rows };
    console.log(`\n${corpus.toUpperCase()} (${runs.baseline[0].docs} docs; stored ${fmtBytes(runs.candidate[0].bytes.json)} JSON, ${fmtBytes(runs.candidate[0].bytes.packed)} packed)`);
    console.log('  path'.padEnd(20) + '0.6.4'.padStart(10) + 'drop-in'.padStart(16) + 'fast'.padStart(16));
    for (const r of rows)
      console.log(
        `  ${r.stage}`.padEnd(20) + fmtMs(r.baseline).padStart(10) +
          `${fmtMs(r.dropIn)} ${(r.baseline / r.dropIn).toFixed(2)}x`.padStart(16) +
          `${fmtMs(r.fast)} ${(r.baseline / r.fast).toFixed(2)}x`.padStart(16)
      );
  }
  if (process.env.EXP_JSON) (await import('node:fs')).writeFileSync(process.env.EXP_JSON, JSON.stringify(results, null, 2));
}
