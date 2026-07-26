// A static server for docs/, so the Service Worker transport can be exercised — Service Workers
// need a secure origin, and http://localhost counts as one.
//
// The only non-obvious rule is the fallback: a request for /p/hello-world/ that arrives before
// the worker is installed has no file behind it, so the shell is served instead and renders the
// permalink client-side. That is exactly what a static host needs to be told to do; on GitHub
// Pages the equivalent is `cp docs/index.html docs/404.html`.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export function startServer({ root, port = 0 } = {}) {
  const base = root ?? fileURLToPath(new URL('./docs', import.meta.url));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // normalize + the leading-slash strip keeps `..` from escaping the root.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(base, rel);

    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');

    // Anything without a real file behind it gets the shell, which routes client-side.
    if (!existsSync(file)) file = join(base, 'index.html');

    const type = MIME[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      // The worker must never be served stale, or an old fetch handler sticks around.
      'cache-control': file.endsWith('sw.js') ? 'no-cache' : 'no-store',
      'service-worker-allowed': '/',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, origin: `http://127.0.0.1:${actual}` });
    });
  });
}

// `npm run serve`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startServer({ port: Number(process.env.PORT ?? 8787) });
  console.log(`serving docs/ at ${origin}`);
  console.log(`  admin:     ${origin}/`);
  console.log(`  permalink: ${origin}/p/hello-world/`);
}
