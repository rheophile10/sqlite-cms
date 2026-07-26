// The Service Worker: this is the web server, when there is one.
//
// It owns no data and runs no SQL. Everything under the content prefix is answered by asking a
// page — which holds the live SQLite connection — over a MessageChannel, and wrapping whatever
// comes back in a Response. That keeps the single-connection rule from db.ts intact: one
// connection, one queue, no second copy of SQLite fighting for the same IndexedDB blocks.
//
// The one case with no page to ask is a cold top-level navigation: somebody pasted
// /p/hello-world/ into a fresh tab. There is no client yet, so we serve the app shell, which
// boots, reads location.pathname, and renders that post as a standalone document. The URL is
// real and shareable either way; on a cold load the HTML is composed a few hundred milliseconds
// later by the page instead of arriving pre-rendered.
//
// Never registered at file:// — Service Workers require a secure origin. See src/transport.ts.

const CACHE = 'sqlite-cms-shell-v1';
const SHELL = new URL('./index.html', self.registration.scope).pathname;

/** Requests under this prefix belong to the site; everything else is a real static asset. */
const CONTENT_PREFIX = new URL('./p/', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll would reject the whole install on one miss; this is the only entry that matters.
      await cache.add(new Request(SHELL, { cache: 'reload' })).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Client ids that hold a live SQLite connection and answer 'cms:request'.
 *
 * Not every client can. A permalink served directly becomes a *rendered post* at the top level —
 * an ordinary document with no application JavaScript in it. Asking it to render its own <img>
 * would stall for the full timeout and then 503. So the shell announces itself and only
 * announced clients are ever asked.
 */
const renderers = new Set();

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'cms:skip-waiting') self.skipWaiting();
  if (data.type === 'cms:hello' && event.source) renderers.add(event.source.id);
});

/** The app shell, for cold navigations. Falls back to the network if it is not cached yet. */
async function shellResponse() {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(SHELL);
  if (hit) return hit;
  try {
    const fresh = await fetch(SHELL);
    if (fresh.ok) cache.put(SHELL, fresh.clone());
    return fresh;
  } catch {
    return new Response('<h1>Offline and the shell is not cached yet.</h1>', {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

/**
 * Ask a shell to render `path`. Prefers the requesting client when it is itself a shell, so the
 * answer comes from the window whose database is on screen; otherwise any announced shell will
 * do. Returns undefined when there is nobody to ask.
 */
async function askClient(path, clientId) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Drop ids for windows that have since gone away, so the set cannot grow without bound.
  const alive = new Set(windows.map((c) => c.id));
  for (const id of renderers) if (!alive.has(id)) renderers.delete(id);

  const shells = windows.filter((c) => renderers.has(c.id));
  const client = shells.find((c) => c.id === clientId) ?? shells[0];
  if (!client) return undefined;

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    // A page mid-boot cannot answer yet; do not hang the request waiting for it.
    const timer = setTimeout(() => resolve(undefined), 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    try {
      client.postMessage({ type: 'cms:request', path }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

function toResponse(answer) {
  if (!answer || !answer.ok) return undefined;
  // body is a string for HTML, an ArrayBuffer for media — Response takes either.
  return new Response(answer.body, {
    status: answer.status || 200,
    headers: {
      'content-type': answer.mime || 'text/html; charset=utf-8',
      // The database is the source of truth and it changes as you type in the admin.
      'cache-control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(CONTENT_PREFIX)) return; // a real file: index.html, sw.js, …

  const path = url.pathname + url.search;

  // A cold top-level navigation has no page to ask. Serve the shell and let it render.
  if (request.destination === 'document') {
    event.respondWith(
      (async () => (await toResponse(await askClient(path, event.clientId))) ?? shellResponse())(),
    );
    return;
  }

  // Iframe navigations and subresources (<img src="…/p/media/x.png">) always have a live
  // parent page, which is exactly the page holding the connection.
  event.respondWith(
    (async () => {
      const answer = await toResponse(await askClient(path, event.clientId));
      if (answer) return answer;
      if (request.destination === 'iframe') return shellResponse();
      return new Response('no page available to render this request', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    })(),
  );
});
