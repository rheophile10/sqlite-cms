// How rendered HTML reaches the iframe. Picked from the environment at boot, not configured.
//
//   hosted (http/https, SW available)   →  real URLs.  iframe.src = "/p/hello-world/", the
//                                          Service Worker intercepts, asks this page for the
//                                          HTML, and answers with a genuine text/html Response.
//                                          Shareable, and view-source shows the served bytes.
//
//   file:// (or SW unavailable)          →  blob: URLs. The same renderer output is handed to
//                                          the browser as a Blob and the frame is pointed at
//                                          it. No server involved at any point.
//
// Both paths call renderPath() in render.ts. The difference is purely how the bytes travel,
// which is why the site looks identical either way — including post <script> tags, which
// execute in both because a blob document is a real document with its own origin.
import type { Db } from '../engine/db.js';
import { renderPath, type RenderOptions, type Served, type Viewer } from '../view/render.js';
import { getMediaBySlug } from '../model/media.js';

export type TransportMode = 'sw' | 'blob';

/**
 * Everything the renderer needs that the transport cannot work out for itself.
 *
 * `base` and `transport` are derived from the environment; these two are not. The origin is a
 * deployment fact, and the viewer belongs to whatever owns the session — so both are supplied by
 * the shell and simply carried through to every render.
 */
export interface SiteContext {
  /** Public origin, for absolute card URLs. */
  origin?: string;
  /** Who is reading, if anybody. */
  viewer?: Viewer;
}

export interface Transport {
  readonly mode: TransportMode;
  /** Human-readable, shown in the admin and in the rendered footer. */
  readonly label: string;
  /** Content root with trailing slash, e.g. `/sqlite-cms/p/`. All site URLs derive from it. */
  readonly base: string;
  /** Point the frame at a site path (`/p/`, `/p/hello-world/`, `/p/search/?q=x`). */
  show(path: string): Promise<void>;
  /** Put arbitrary HTML in the frame — the admin's draft preview, which has no URL. */
  showHtml(html: string): Promise<void>;
  /** A shareable absolute URL for a site path, or null when there is nothing to share. */
  linkFor(path: string): string | null;
  dispose(): void;
}

/** The single path segment under which all site content is served. */
const CONTENT_SEGMENT = 'p';

/**
 * Directory containing the shell document — the Service Worker's scope, and the root every site
 * URL is built from.
 *
 * The subtlety: this document is not always *at* the shell's URL. When the worker answers a cold
 * permalink it serves the shell bytes at `/p/hello-world/`, so `new URL('./', location.href)`
 * would report the permalink's own directory and everything downstream — the content base, the
 * sw.js registration path — would be wrong. So when the current path contains the content
 * segment, the shell is the directory holding it.
 *
 * Known limitation: a deployment whose own directory is literally named `p` would confuse this.
 */
function shellDirectory(): string {
  const marker = `/${CONTENT_SEGMENT}/`;
  const at = location.pathname.indexOf(marker);
  if (at >= 0) return location.pathname.slice(0, at + 1);
  return new URL('./', location.href).pathname;
}

/** Everything the site serves lives under this prefix, so it can never collide with the shell. */
export function contentBase(): string {
  return `${shellDirectory()}${CONTENT_SEGMENT}/`;
}

/** True when the current top-level URL is a site permalink rather than the admin shell. */
export function isSitePath(path = location.pathname): boolean {
  return path.startsWith(contentBase());
}

// ---------------------------------------------------------------------------------------------
// blob: transport — the file:// path, and the fallback whenever a Service Worker is unavailable
// ---------------------------------------------------------------------------------------------

/** Bytes → `data:` URI, chunked so a large image cannot blow the argument limit. */
function toDataUri(mime: string, bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Rewrite `…/p/media/<slug>` references to `data:` URIs holding the actual bytes.
 *
 * Needed only in blob mode: a blob document has no Service Worker to ask, so images have to be
 * handed to it directly. They are `data:` rather than `blob:` for a specific reason — a document
 * at an opaque origin cannot load a `blob:null/…` subresource. Chromium rejects it outright with
 * "Not allowed to load local resource", even though the parent created the URL and the parent's
 * own navigation to a blob document is fine. A `data:` URI carries its bytes inline and depends
 * on no origin at all, so it is the only form that works here. The cost is base64's 33 %
 * inflation, paid per render.
 *
 * Uses DOMParser rather than a regex because the input is author-controlled HTML and attribute
 * quoting, casing and entity forms all vary. This is the one function in the render path that
 * needs a DOM, which is why it lives here and not in render.ts.
 */
async function inlineMedia(db: Db, html: string, base: string): Promise<string> {
  const mediaPrefix = `${base}media/`;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const attrs = ['src', 'href', 'poster'] as const;
  const pending: Promise<void>[] = [];
  const resolved = new Map<string, string>();

  for (const element of Array.from(doc.querySelectorAll('[src], [href], [poster]'))) {
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      // Normalise against the shell's URL so relative and absolute forms both match.
      const path = new URL(value, `${location.origin}${base}`).pathname;
      if (!path.startsWith(mediaPrefix)) continue;
      const slug = decodeURIComponent(path.slice(mediaPrefix.length));

      pending.push(
        (async () => {
          let url = resolved.get(slug);
          if (url === undefined) {
            const media = await getMediaBySlug(db, slug);
            if (!media) return; // leave the broken reference visible rather than hiding it
            // .slice() copies off the wasm heap, which moves the moment the next query runs.
            url = toDataUri(media.mime, media.bytes.slice());
            resolved.set(slug, url);
          }
          element.setAttribute(attr, url);
        })(),
      );
    }
  }

  // Sequential: each getMediaBySlug goes through the one connection queue anyway, and awaiting
  // them together would only pile up promises against it.
  for (const job of pending) await job;

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function createBlobTransport(
  db: Db,
  frame: HTMLIFrameElement,
  label: string,
  context: SiteContext,
): Transport {
  const base = contentBase();
  const options: RenderOptions = { base, transport: label, ...context };

  // The one blob URL backing whatever is on screen. Media is inlined as data: URIs, so the
  // document is the only thing needing a URL — and the only thing needing revoking.
  let current: string | undefined;

  /**
   * Point the frame at a new document. The outgoing URL is released on the frame's next load
   * event rather than immediately: the browser still needs it readable while it tears the old
   * document down.
   */
  function swap(documentUrl: string): void {
    const stale = current;
    current = documentUrl;
    if (stale) {
      frame.addEventListener('load', () => URL.revokeObjectURL(stale), { once: true });
    }
    frame.src = documentUrl;
  }

  async function put(html: string): Promise<void> {
    const withMedia = await inlineMedia(db, html, base);
    swap(URL.createObjectURL(new Blob([withMedia], { type: 'text/html' })));
  }

  return {
    mode: 'blob',
    label,
    base,
    async show(path) {
      const served = await renderPath(db, path, options);
      if (served.kind === 'html') {
        await put(served.body);
        return;
      }
      // A direct hit on /p/media/x — show the asset as a document of its own. Navigating the
      // frame to a blob URL is allowed; it is only subresource loads from inside one that are
      // blocked, which is what inlineMedia works around.
      swap(URL.createObjectURL(new Blob([served.body.slice()], { type: served.mime })));
    },
    showHtml: put,
    linkFor: () => null, // a blob: URL is meaningless outside this tab
    dispose() {
      if (current) URL.revokeObjectURL(current);
      current = undefined;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Service Worker transport — real URLs when hosted
// ---------------------------------------------------------------------------------------------

interface ServeAnswer {
  ok: boolean;
  status: number;
  mime: string;
  body: string | ArrayBuffer;
}

function answerFor(served: Served): ServeAnswer {
  if (served.kind === 'html') {
    return { ok: true, status: served.status, mime: served.mime, body: served.body };
  }
  // Copy off the wasm heap before it crosses the postMessage boundary.
  const copy = served.body.slice();
  return {
    ok: true,
    status: served.status,
    mime: served.mime,
    body: copy.buffer as ArrayBuffer,
  };
}

/**
 * Register the worker and wait until it actually controls this page. Returns false — so the
 * caller can fall back to blob: — on an insecure origin, a missing sw.js, a browser with
 * Service Workers disabled, or an activation that simply never lands.
 */
async function activateWorker(timeoutMs = 8000): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !isSecureContext) return false;
  try {
    // An already-controlling worker is the common case for a permalink visit — it is what served
    // this document. Registering again would be harmless but pointless, and the check has to come
    // first because this document's own directory is not necessarily where sw.js lives.
    if (navigator.serviceWorker.controller) return true;

    const dir = shellDirectory();
    const registration = await navigator.serviceWorker.register(
      new URL(`${dir}sw.js`, location.origin),
      { scope: dir },
    );
    registration.waiting?.postMessage({ type: 'cms:skip-waiting' });
    if (navigator.serviceWorker.controller) return true;

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), timeoutMs);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });
  } catch {
    return false;
  }
}

function createSwTransport(
  db: Db,
  frame: HTMLIFrameElement,
  label: string,
  context: SiteContext,
): Transport {
  const base = contentBase();
  const options: RenderOptions = { base, transport: label, ...context };
  let previewUrl: string | undefined;

  // The worker's fetch handler asks us for every path under the content prefix. This listener
  // is the entire server-side application.
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; path?: string } | null;
    if (!data || data.type !== 'cms:request' || typeof data.path !== 'string') return;
    const port = event.ports[0];
    if (!port) return;
    void (async () => {
      try {
        port.postMessage(answerFor(await renderPath(db, data.path as string, options)));
      } catch (err) {
        port.postMessage({
          ok: true,
          status: 500,
          mime: 'text/html; charset=utf-8',
          body: `<pre style="padding:20px;color:#b91c1c;white-space:pre-wrap">render failed\n${
            err instanceof Error ? err.message : String(err)
          }</pre>`,
        });
      }
    })();
  };

  navigator.serviceWorker.addEventListener('message', onMessage);

  // Tell the worker this client can render. Without it the worker would also try asking
  // documents that are themselves rendered output — a permalink served at the top level is an
  // ordinary post, with no listener above — and every subresource would stall then fail.
  const announce = (): void =>
    navigator.serviceWorker.controller?.postMessage({ type: 'cms:hello' });
  announce();
  // A worker update swaps the controller out; the new one has an empty registry.
  navigator.serviceWorker.addEventListener('controllerchange', announce);

  return {
    mode: 'sw',
    label,
    base,
    async show(path) {
      // Cache-bust so re-showing the same path after an edit refetches through the worker
      // rather than reusing the frame's own in-memory copy.
      const url = new URL(path, location.origin);
      url.searchParams.set('_', String(performance.now() | 0));
      frame.src = url.pathname + url.search;
    },
    async showHtml(html) {
      // A draft preview has no URL, so even in SW mode this one goes through a blob.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      frame.src = previewUrl;
    },
    linkFor: (path) => new URL(path, location.origin).href,
    dispose() {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', announce);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
  };
}

/**
 * Pick a transport for wherever this page happens to be running. Tries the Service Worker
 * first when the context allows one at all, and falls back to blob: otherwise — so a
 * double-clicked .html file and a deployed site run the same code with different plumbing.
 */
export async function createTransport(
  db: Db,
  frame: HTMLIFrameElement,
  context: SiteContext = {},
): Promise<Transport> {
  if (location.protocol === 'file:') {
    return createBlobTransport(db, frame, 'blob: URL (file://)', context);
  }
  if (await activateWorker()) {
    return createSwTransport(
      db,
      frame,
      `service worker (${location.protocol.replace(':', '')})`,
      context,
    );
  }
  return createBlobTransport(db, frame, 'blob: URL (no service worker)', context);
}
