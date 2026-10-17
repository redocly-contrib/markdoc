#!/usr/bin/env node
const { buildSync } = require('esbuild');

const shared = {
  bundle: true,
  entryPoints: ['index.ts'],
  outdir: 'dist',
  sourcemap: 'external',
  external: [],
  format: 'esm',
};

buildSync({ ...shared, format: 'cjs' });
buildSync({ ...shared, outExtension: { '.js': '.mjs' } });
buildSync({ ...shared, entryPoints: ['src/renderers/react/react.ts'] });

// The optional HTML handler, with htmlparser2 bundled in, so it costs nothing
// to programs that do not import it.
buildSync({ ...shared, entryPoints: ['html.ts'], format: 'cjs' });
buildSync({ ...shared, entryPoints: ['html.ts'], outExtension: { '.js': '.mjs' } });
