import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// index.html (including the base64 wasm) ends up fully inline in docs/index.html, so the
// built page has zero subresource requests and therefore works from file://.
//
// public/sw.js is deliberately NOT part of that bundle. A Service Worker has to be fetchable
// at its own URL to register at all, so vite copies it verbatim into docs/. At file:// it is
// simply never registered; the blob: transport is used instead. See src/transport.ts.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { outDir: 'docs', target: 'esnext', assetsInlineLimit: 100000000, cssCodeSplit: false },
});
