import { defineConfig, type Plugin } from 'vite';

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
  plugins: [cspPlugin()],
});
