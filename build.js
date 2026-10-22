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
// to programs that do not import it. Only its `Parser` is used, and the
// package root would also pull in domutils and dom-serializer, which the
// bundle cannot drop; htmlparser2 exports no path to `Parser` alone.
const html = {
  ...shared,
  entryPoints: ['html.ts'],
  alias: { htmlparser2: './node_modules/htmlparser2/lib/esm/Parser.js' },
};
buildSync({ ...html, format: 'cjs', platform: 'node' });
buildSync({ ...html, outExtension: { '.js': '.mjs' } });
