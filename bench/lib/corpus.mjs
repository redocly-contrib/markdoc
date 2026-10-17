// Loads the two benchmark corpora and caches them so every experiment runs on
// byte-identical input.
//
//   pages        - real Markdoc documentation pages (Realm docs, the Redocly
//                  intranet, the portal playground). Long-form content with
//                  heavy custom-tag usage.
//   descriptions - every `description` string from a large real-world OpenAPI
//                  spec (Rebilly). Thousands of short snippets: the API-docs
//                  workload.
//
// Set REDOCLY_REPO to point elsewhere. The corpus itself is never committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REDOCLY_REPO || '/Users/romanhotsiy/Projects/redocly';
const CACHE = path.join(here, '..', '.cache', 'corpus.json');

const PAGE_DIRS = ['docs/realm', 'docs/intranet', 'packages/portal/playground'];
const SPEC = 'packages/portal/playground/api-docs/big-openapi/rebilly.yaml';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function collectDescriptions(value, out) {
  if (Array.isArray(value)) for (const v of value) collectDescriptions(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === 'description' && typeof v === 'string' && v.trim()) out.push(v);
      else collectDescriptions(v, out);
    }
  return out;
}

export function loadCorpus() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));

  const pages = PAGE_DIRS.flatMap((d) => walk(path.join(REPO, d)))
    .sort()
    .map((file) => ({
      file: path.relative(REPO, file),
      source: fs.readFileSync(file, 'utf8'),
    }));

  const spec = YAML.parse(fs.readFileSync(path.join(REPO, SPEC), 'utf8'), {
    maxAliasCount: -1,
  });
  const descriptions = collectDescriptions(spec, []);

  const corpus = { pages, descriptions };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(corpus));
  return corpus;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pages, descriptions } = loadCorpus();
  const bytes = (xs) => xs.reduce((n, s) => n + Buffer.byteLength(s), 0);
  console.log(
    `pages:        ${pages.length} files, ${(bytes(pages.map((p) => p.source)) / 1e6).toFixed(2)} MB`
  );
  console.log(
    `descriptions: ${descriptions.length} strings, ${(bytes(descriptions) / 1e6).toFixed(2)} MB, ` +
      `median ${descriptions.map((d) => d.length).sort((a, b) => a - b)[descriptions.length >> 1]} chars`
  );
}
