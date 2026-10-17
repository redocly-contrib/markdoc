// Times every pipeline stage for ONE library build in a fresh process and
// prints the per-stage CPU medians as JSON. Driven by bench/ab.mjs.
//
//   NODE_ENV=production node --expose-gc bench/worker.mjs <baseline|candidate|path> <pages|descriptions> [stage,...]
//
// Only one build is ever loaded per process: with two copies of the library in
// one process, whichever was required first ran ~35% faster on transform and
// validate even when the two files were byte-identical.
import { loadMarkdoc, prepare, stageFn, STAGES, PREPARED_STAGES } from './lib/pipeline.mjs';
import { compare } from './lib/harness.mjs';

const [which, corpusName, stageList] = process.argv.slice(2);
const s = prepare(loadMarkdoc(which), corpusName);
const stages = (stageList ? stageList.split(',') : [...STAGES, ...PREPARED_STAGES]).filter(
  (name) => s.prepared || !PREPARED_STAGES.includes(name)
);
const results = compare(
  Object.fromEntries(stages.map((name) => [name, stageFn(name, s)])),
  { rounds: 7, warmup: 3 }
);

const bytes = s.json.reduce((n, j) => n + j.length, 0);
process.stdout.write(
  JSON.stringify({
    which,
    corpus: corpusName,
    docs: s.sources.length,
    storedBytes: bytes,
    stages: Object.fromEntries(
      Object.entries(results).map(([k, r]) => [k, r.cpu.median])
    ),
  })
);
