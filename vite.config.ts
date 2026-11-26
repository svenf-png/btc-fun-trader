import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Unique id per build: commit sha in GitHub Actions, otherwise a timestamp.
const BUILD_ID = (process.env.GITHUB_SHA ?? '').slice(0, 7) || `local-${Date.now().toString(36)}`;

/** Writes dist/version.json and stamps the build id into dist/sw.js (so the browser sees a new worker). */
const versionPlugin = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'version',
    apply: 'build',
    configResolved: (c) => {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle: () => {
      writeFileSync(resolve(outDir, 'version.json'), JSON.stringify({ build: BUILD_ID }));
      const sw = resolve(outDir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replaceAll('__BUILD_ID__', BUILD_ID));
    },
  };
};

// Strict Content Security Policy, only in the production build
// (the dev server needs inline styles and its own HMR WebSocket).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' wss://ws-feed.exchange.coinbase.com wss://ws.kraken.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// VITE_BASE lets you deploy under a sub path (e.g. GitHub Pages: /btc-fun-trader/).
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  build: { target: 'es2022' },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [cspPlugin(), versionPlugin()],
});
