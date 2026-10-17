// A/B: published baseline (@redocly/markdoc 0.6.4) vs this repo's dist build.
//
//   NODE_ENV=production node --expose-gc bench/ab.mjs [stage,...|all] [pages|descriptions] [rounds]
//
// 1. Checks the candidate is output-identical to the baseline over the whole
//    corpus: tokens, parsed AST, stored JSON, validation errors, renderable
//    tree, HTML and React element tree. A faster build that changes output is
//    a failure, not a win.
// 2. Times each build in its own fresh process (bench/worker.mjs), alternating
//    which goes first, and reports the median of the per-process medians.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadMarkdoc, prepare, CORPORA, React } from './lib/pipeline.mjs';
import { fmtMs, fmtBytes, summarize } from './lib/harness.mjs';

if (process.env.NODE_ENV !== 'production')
  throw new Error('Run with NODE_ENV=production so React dev warnings do not skew timing');

const [stageArg, corpusArg, roundsArg] = process.argv.slice(2);
const corpora = corpusArg ? [corpusArg] : Object.keys(CORPORA);
const rounds = Number(roundsArg || 4);
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');

function reactShape(el) {
  // Stable comparison of a React element tree (functions by name).
  return JSON.stringify(el, (k, v) => (typeof v === 'function' ? v.name || 'fn' : v));
}

function checkIdentical(corpusName) {
  const a = prepare(loadMarkdoc('baseline'), corpusName);
  const b = prepare(loadMarkdoc('candidate'), corpusName);
  const fail = (what, i) => {
    throw new Error(`${corpusName}: candidate output differs from baseline (${what}, doc #${i})`);
  };
  for (let i = 0; i < a.sources.length; i++) {
    if (JSON.stringify(a.tokens[i]) !== JSON.stringify(b.tokens[i])) fail('tokens', i);
    if (JSON.stringify(a.asts[i]) !== JSON.stringify(b.asts[i])) fail('parsed AST', i);
    if (JSON.stringify(a.asts[i]) !== JSON.stringify(b.direct(b.sources[i])))
      fail('parsed AST (source → AST path)', i);
    if (a.json[i] !== b.json[i]) fail('stored JSON', i);
    if (JSON.stringify(a.M.validate(a.asts[i], a.config)) !==
        JSON.stringify(b.M.validate(b.asts[i], b.config))) fail('validate', i);
    if (JSON.stringify(a.trees[i]) !== JSON.stringify(b.trees[i])) fail('renderable tree', i);
    if (a.M.renderers.html(a.trees[i]) !== b.M.renderers.html(b.trees[i])) fail('html', i);
    if (reactShape(a.M.renderers.react(a.trees[i], React, { components: a.components })) !==
        reactShape(b.M.renderers.react(b.trees[i], React, { components: b.components })))
      fail('react', i);
  }
  console.log(`${CORPORA[corpusName].label}: candidate output identical to baseline on ${a.sources.length} docs`);
}

function runWorker(which, corpusName) {
  const args = ['--expose-gc', worker, which, corpusName];
  if (stageArg && stageArg !== 'all') args.push(stageArg);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`worker ${which} ${corpusName} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

if (!process.env.AB_SKIP_CHECK) for (const corpusName of corpora) checkIdentical(corpusName);

const summary = {};
for (const corpusName of corpora) {
  const runs = { baseline: [], candidate: [] };
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const which of order) runs[which].push(runWorker(which, corpusName));
  }

  // A prepared stage has no baseline counterpart; compare it with the plain one.
  const stageNames = Object.keys(runs.candidate[0].stages);
  const baseStage = (stage) => stage.replace(' (prepared)', '');
  const med = (which, stage) =>
    summarize(runs[which].map((x) => x.stages[which === 'baseline' ? baseStage(stage) : stage]));
  const { label } = CORPORA[corpusName];
  const bBytes = runs.baseline[0].storedBytes;
  const cBytes = runs.candidate[0].storedBytes;
  console.log(
    `\n${label} (${runs.baseline[0].docs} docs; ${rounds} processes per build; stored JSON ` +
      `${fmtBytes(bBytes)} -> ${fmtBytes(cBytes)})`
  );
  console.log('  stage'.padEnd(22) + 'baseline'.padStart(12) + 'candidate'.padStart(12) + '   speedup   candidate range');
  let tb = 0, tc = 0;
  summary[corpusName] = { stages: {}, storedBytes: { baseline: bBytes, candidate: cBytes } };
  for (const stage of stageNames) {
    const b = med('baseline', stage);
    const c = med('candidate', stage);
    if (stage === baseStage(stage)) {
      tb += b.median;
      tc += c.median;
    }
    summary[corpusName].stages[stage] = { baseline: b.median, candidate: c.median };
    console.log(
      `  ${stage}`.padEnd(22) +
        fmtMs(b.median).padStart(12) +
        fmtMs(c.median).padStart(12) +
        `${(b.median / c.median).toFixed(2)}x`.padStart(10) +
        `   ${fmtMs(c.min)}–${fmtMs(Math.max(...runs.candidate.map((x) => x.stages[stage])))}`
    );
  }
  console.log('  total (plain stages)'.padEnd(22) + fmtMs(tb).padStart(12) + fmtMs(tc).padStart(12) + `${(tb / tc).toFixed(2)}x`.padStart(10));
}

if (process.env.AB_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.AB_JSON, JSON.stringify(summary, null, 2));
}
