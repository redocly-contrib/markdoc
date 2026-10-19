#!/usr/bin/env node
const { rmSync } = require('fs');
const { buildSync } = require('esbuild');

// Start from an empty dist, so files of removed modules are not published.
rmSync('dist', { recursive: true, force: true });

const shared = {
  bundle: true,
  entryPoints: ['index.ts'],
  outdir: 'dist',
  sourcemap: 'external',
  external: [],
  format: 'esm',
};

// `platform: 'node'` makes esbuild annotate the CommonJS builds' exports, so
// Node can import them by name from ES modules too.
buildSync({ ...shared, format: 'cjs', platform: 'node' });
buildSync({ ...shared, outExtension: { '.js': '.mjs' } });
buildSync({ ...shared, entryPoints: ['src/renderers/react/react.ts'] });

// The optional HTML handler, with htmlparser2 bundled in, so it costs nothing
// to programs that do not import it.
buildSync({
  ...shared,
  entryPoints: ['html.ts'],
  format: 'cjs',
  platform: 'node',
});
buildSync({
  ...shared,
  entryPoints: ['html.ts'],
  outExtension: { '.js': '.mjs' },
});
