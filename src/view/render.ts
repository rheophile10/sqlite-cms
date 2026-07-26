// The router and renderer — the part that stands in for PHP.
//
// `renderPath` takes a request path and returns a complete HTTP-shaped answer: status, MIME type,
// and a body that is either an HTML string or raw bytes. It has no idea whether it is being called
// by a Service Worker's fetch handler or by the blob: fallback; that is the whole point of the
// seam. Both transports call this one function, so there is exactly one description of what the
// site looks like.
//
// Deliberately free of DOM APIs so the Node test suite can exercise real routing and real template
// output. Anything needing a `document` lives in transport.ts.
import type { Db } from '../engine/db.js';
import { getCollectionBySlug, listCollections } from '../model/collections.js';
import {
  ancestorsOf,
  childrenOf,
  getPublishedBySlug,
  listDocuments,
  searchDocuments,
  subtree,
  type Doc,
  type DocNode,
} from '../model/documents.js';
import { getMediaBySlug } from '../model/media.js';
import { getPartByAnchor, listParts, type Part } from '../model/parts.js';
import {
  EMPTY_QUERY,
  groupByDocument,
  isEmptyQuery,
  parseQuery,
  queryToString,
  runQuery,
  toggleTerm,
  type FacetValue,
  type Query,
  type QueryPart,
} from '../model/query.js';
import { relatedDocuments, relatedParts } from '../model/relations.js';
import { getSetting } from '../model/settings.js';
import { pageStats } from '../model/schema.js';
import { listTerms, getTermBySlug, termsForDocument, type Term } from '../model/taxonomy.js';
import { escapeHtml, renderTemplate } from './template.js';
import { loadTemplates } from './theme.js';
import { renderParts } from './widgets.js';

export interface RenderOptions {
  /**
   * Site root, with trailing slash. `/p/` when hosted at a domain root, `/cms/docs/p/` under
   * GitHub Pages. Every generated URL is built from this, so the same database renders correctly
   * wherever it is deployed.
   */
  base: string;
  /** Shown in the footer so the page states which transport produced it. */
  transport: string;
}

export type Served =
  | { kind: 'html'; status: number; mime: 'text/html; charset=utf-8'; body: string }
  | { kind: 'asset'; status: number; mime: string; body: Uint8Array };

/** Recognised routes, in the order they are tried. */
export type Route =
  | { name: 'index' }
  /** Carries the raw query string; model/query.ts owns the parameter vocabulary. */
  | { name: 'query'; search: string }
  | { name: 'archive'; kind: 'category' | 'tag'; slug: string }
  | { name: 'collection'; slug: string }
  | { name: 'media'; slug: string }
  | { name: 'part'; slug: string; anchor: string }
  | { name: 'document'; slug: string };

/**
 * Split a request into a route. Accepts the path with or without the site base, and with or
 * without a trailing slash, because all three show up in practice: the SW sees a full pathname,
 * the blob transport sees whatever a link's href said.
 */
export function routeOf(path: string, base = '/'): Route {
  // Strip the base, tolerating the bare form (`/p` as well as `/p/`) without also matching an
  // unrelated sibling that merely shares the prefix (`/painting/` must not become `ainting/`).
  let rest = path;
  const bare = base.replace(/\/+$/, '');
  if (bare && (rest === bare || rest.startsWith(`${bare}/`) || rest.startsWith(`${bare}?`))) {
    rest = rest.slice(bare.length);
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '');

  // A query string may still be attached when the caller passed a raw href.
  const [clean = '', search = ''] = rest.split('?');
  const params = new URLSearchParams(search);
  const segments = clean.split('/').filter(Boolean).map(decodeURIComponent);

  const [first, second, third] = segments;
  if (!first || first === 'index.html') {
    // Home doubles as the query page: any parameter turns it into one. `_` is excluded because the
    // Service Worker transport appends it to bust the frame's own cache, and that is not a query.
    const asked = [...params.keys()].some((key) => key !== '_');
    return asked ? { name: 'query', search } : { name: 'index' };
  }
  // /p/search/ is kept as an alias so links made before the parameter vocabulary existed still work.
  if (first === 'query' || first === 'search') return { name: 'query', search };
  if ((first === 'category' || first === 'tag') && second)
    return { name: 'archive', kind: first, slug: second };
  if (first === 'collection' && second) return { name: 'collection', slug: second };
  if (first === 'media' && second) return { name: 'media', slug: second };
  // A part of a document, addressable on its own: /p/<slug>/part/<anchor>/
  if (second === 'part' && third) return { name: 'part', slug: first, anchor: third };
  return { name: 'document', slug: first };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2026-07-26 14:03:11` → `July 26, 2026`. Left alone if it is not that shape. */
export function formatDate(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
  if (!m) return stamp;
  const [, year, month, day] = m;
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

/** Clip already-flat text to a display length. */
export function clip(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
}

/**
 * Runs inside every rendered document. Link clicks and search submits become messages to the
 * shell instead of real navigations, which is what makes one renderer work in both transports: at
 * file:// there is no URL to navigate to, and when hosted we still want the shell's own address
 * bar to stay in step.
 */
const BRIDGE = /* html */ `
<script>
(function () {
  var send = function (msg) {
    try { parent.postMessage(msg, '*'); } catch (e) {}
  };
  // Only intercept links that stay inside the site; leave real external links alone. A bare
  // fragment is left to the browser so deep links to a part still scroll rather than re-render.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^(https?:)?\\/\\//i.test(href) || /^(mailto|tel):/i.test(href)) return;
    if (href.charAt(0) === '#') return;
    if (a.target === '_blank') return;
    ev.preventDefault();
    send({ type: 'cms:navigate', href: href });
  });
  // A query form submits its whole self: every named field becomes a URL parameter, so the
  // address bar ends up holding the entire query and a result set is a shareable link.
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form) return;
    if (form.hasAttribute('data-cms-query') || form.hasAttribute('data-cms-search')) {
      ev.preventDefault();
      var params = new URLSearchParams();
      var fields = form.querySelectorAll('[name]');
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (field.disabled || !field.name) continue;
        if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) continue;
        if (field.value === '') continue;
        params.append(field.name, field.value);
      }
      send({ type: 'cms:query', search: params.toString() });
    }
  });
})();
</script>
`;

// ── URL builders ───────────────────────────────────────────────────────────────────────────

const docUrl = (base: string, doc: { slug: string }): string =>
  `${base}${encodeURIComponent(doc.slug)}/`;

const partUrl = (base: string, slug: string, anchor: string): string =>
  `${base}${encodeURIComponent(slug)}/part/${encodeURIComponent(anchor)}/`;

const termUrl = (base: string, term: Pick<Term, 'kind' | 'slug'>): string =>
  `${base}${term.kind}/${encodeURIComponent(term.slug)}/`;

const collectionUrl = (base: string, slug: string): string =>
  `${base}collection/${encodeURIComponent(slug)}/`;

// ── View shaping ───────────────────────────────────────────────────────────────────────────

interface DocView {
  id: number;
  title: string;
  subtitle: string;
  number: string;
  slug: string;
  url: string;
  created: string;
  excerpt: string;
  type: string;
  terms?: { name: string; slug: string; kind: string; url: string }[];
}

function docView(base: string, doc: Doc, terms?: Term[]): DocView {
  return {
    id: doc.id,
    title: doc.title,
    subtitle: doc.subtitle,
    number: doc.number,
    slug: doc.slug,
    url: docUrl(base, doc),
    created: formatDate(doc.created),
    excerpt: doc.excerpt,
    type: doc.type,
    ...(terms ? { terms: terms.map((t) => ({ ...t, url: termUrl(base, t) })) } : {}),
  };
}

/**
 * Depth-first flatten of a document tree.
 *
 * The template language has no recursion, so a nested table of contents is rendered from a flat
 * list carrying a `depth` per row and indented with CSS. That keeps the language small, which is
 * the right trade when templates are user-editable content.
 */
export function flattenTree(nodes: readonly DocNode[], base: string): (DocView & { depth: number })[] {
  const rows: (DocView & { depth: number })[] = [];
  const walk = (list: readonly DocNode[]): void => {
    for (const node of list) {
      rows.push({ ...docView(base, node), depth: node.depth });
      walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

/** Everything the layout needs regardless of which inner template runs. */
async function siteContext(db: Db, options: RenderOptions) {
  const pages = await listDocuments(db, { type: 'page', status: 'published' });
  const collections = await listCollections(db);
  const stats = await pageStats(db);
  return {
    site: {
      title: (await getSetting(db, 'site.title')) || 'A SQLite Site',
      tagline: (await getSetting(db, 'site.tagline')) || 'Served out of the database',
      home: options.base,
      pages: pages.map((p) => ({ title: p.title, url: docUrl(options.base, p) })),
      // Only collections with something in them belong in the nav.
      collections: collections
        .filter((c) => c.count > 0)
        .map((c) => ({ title: c.title, url: collectionUrl(options.base, c.slug) })),
    },
    transport: options.transport,
    pages: stats.pages,
  };
}

const HTML_MIME = 'text/html; charset=utf-8' as const;

/** Compose an inner template into the layout and attach the bridge. */
function compose(
  templates: Record<string, string>,
  inner: string,
  title: string,
  data: Record<string, unknown>,
): string {
  const content = renderTemplate(templates[inner] ?? '', data);
  const html = renderTemplate(templates.layout ?? '', {
    ...data,
    title,
    content,
    style: templates.style ?? '',
  });
  return html.includes('</body>') ? html.replace('</body>', `${BRIDGE}</body>`) : html + BRIDGE;
}

/** The rendered body of a document: its parts, through their widget renderers. */
async function renderDocumentParts(
  db: Db,
  templates: Record<string, string>,
  doc: Doc,
  ctx: { site: unknown },
  options: RenderOptions,
): Promise<{ html: string; parts: Part[] }> {
  const parts = await listParts(db, doc.id);
  return {
    parts,
    html: renderParts(templates, parts, { site: ctx.site, base: options.base, unlocked: false }),
  };
}

async function notFound(
  templates: Record<string, string>,
  ctx: Record<string, unknown>,
  path: string,
): Promise<Served> {
  return {
    kind: 'html',
    status: 404,
    mime: HTML_MIME,
    body: compose(templates, 'notfound', 'Not found', { ...ctx, query: '', path }),
  };
}

/**
 * Resolve one request against the database. This is the function a Service Worker's fetch handler
 * and the blob: fallback both call; nothing else needs to know the route table.
 */
export async function renderPath(db: Db, path: string, options: RenderOptions): Promise<Served> {
  const route = routeOf(path, options.base);
  const base = options.base;

  // Media first: it needs no templates and no site context, and it is the hottest route on any
  // page carrying images.
  if (route.name === 'media') {
    const blob = await getMediaBySlug(db, route.slug);
    if (!blob) {
      return {
        kind: 'asset',
        status: 404,
        mime: 'text/plain; charset=utf-8',
        body: new TextEncoder().encode(`no media ${route.slug}`),
      };
    }
    return { kind: 'asset', status: 200, mime: blob.mime, body: blob.bytes };
  }

  const templates = await loadTemplates(db);
  const ctx = await siteContext(db, options);

  switch (route.name) {
    case 'index': {
      const docs = await listDocuments(db, { type: 'post', status: 'published' });
      const views: DocView[] = [];
      for (const doc of docs) views.push(docView(base, doc, await termsForDocument(db, doc.id)));
      const categories = (await listTerms(db, 'category')).map((t) => ({
        ...t,
        url: termUrl(base, t),
      }));
      const collections = (await listCollections(db))
        .filter((c) => c.count > 0)
        .map((c) => ({ ...c, url: collectionUrl(base, c.slug) }));
      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, 'index', ctx.site.title, {
          ...ctx,
          query: '',
          posts: views,
          categories,
          collections,
        }),
      };
    }

    case 'query': {
      const query = parseQuery(new URLSearchParams(route.search));
      const result = await runQuery(db, query);
      const titles = query.q ? await searchDocuments(db, query.q, 6) : [];

      /** A URL for some variation on the current query — the whole UI is these links. */
      const linkTo = (next: Query): string => {
        const search = queryToString(next);
        return `${base}query/${search ? `?${search}` : ''}`;
      };

      const facetGroup = (
        field: 'tags' | 'categories' | 'kinds' | 'types',
        values: readonly FacetValue[],
      ) => {
        const active = new Set(query[field] as string[]);
        return values.map((value) => ({
          ...value,
          active: active.has(value.value),
          url: linkTo(toggleTerm(query, field, value.value)),
        }));
      };

      // snippet() wraps matches in «» — our own delimiters, so this substitution cannot collide
      // with author markup. Escape first, then promote the delimiters to <mark>. With no
      // full-text expression the snippet is a plain clip and simply has no delimiters to promote.
      const decorate = (hit: QueryPart) => ({
        url: partUrl(base, hit.slug, hit.anchor),
        documentUrl: docUrl(base, hit),
        documentTitle: hit.title,
        number: hit.number,
        kind: hit.kind,
        type: hit.type,
        created: formatDate(hit.created),
        score: query.q ? hit.rank.toFixed(2) : '',
        snippet: escapeHtml(hit.snippet).replace(/«/g, '<mark>').replace(/»/g, '</mark>'),
      });

      const shown = query.offset + result.parts.length;
      const active = [
        ...query.tags.map((value) => ({
          label: `tag: ${value}`,
          url: linkTo(toggleTerm(query, 'tags', value)),
        })),
        ...query.categories.map((value) => ({
          label: `category: ${value}`,
          url: linkTo(toggleTerm(query, 'categories', value)),
        })),
        ...query.kinds.map((value) => ({
          label: `kind: ${value}`,
          url: linkTo(toggleTerm(query, 'kinds', value)),
        })),
        ...query.types.map((value) => ({
          label: `type: ${value}`,
          url: linkTo(toggleTerm(query, 'types', value)),
        })),
        ...(query.collection
          ? [{ label: `collection: ${query.collection}`, url: linkTo({ ...query, collection: '' }) }]
          : []),
      ];

      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, 'query', query.q ? `Query: ${query.q}` : 'Query', {
          ...ctx,
          // `query` is the raw text so the search box round-trips; `criteria` is the structure.
          query: query.q,
          criteria: query,
          empty: isEmptyQuery(query),
          results: result.parts.map(decorate),
          groups:
            query.group === 'documents'
              ? groupByDocument(result.parts).map((group) => ({
                  ...group,
                  url: docUrl(base, group),
                  created: formatDate(group.created),
                  passages: group.passages.map(decorate),
                }))
              : [],
          grouped: query.group === 'documents',
          total: result.total,
          shown,
          from: result.parts.length ? query.offset + 1 : 0,
          active,
          facets: {
            tags: facetGroup('tags', result.facets.tags),
            categories: facetGroup('categories', result.facets.categories),
            kinds: facetGroup('kinds', result.facets.kinds),
            types: facetGroup('types', result.facets.types),
          },
          titles: titles.map((t) => ({ ...t, url: docUrl(base, t) })),
          sorts: (['relevance', 'newest', 'oldest'] as const)
            // Relevance needs something to rank against.
            .filter((sort) => sort !== 'relevance' || Boolean(query.q))
            .map((sort) => ({
              value: sort,
              active: query.sort === sort,
              url: linkTo({ ...query, sort, offset: 0 }),
            })),
          groupings: (['parts', 'documents'] as const).map((group) => ({
            value: group,
            active: query.group === group,
            url: linkTo({ ...query, group }),
          })),
          prev:
            query.offset > 0
              ? linkTo({ ...query, offset: Math.max(0, query.offset - query.limit) })
              : '',
          next: shown < result.total ? linkTo({ ...query, offset: query.offset + query.limit }) : '',
          clear: linkTo({ ...EMPTY_QUERY, limit: query.limit }),
        }),
      };
    }

    case 'archive': {
      const term = await getTermBySlug(db, route.kind, route.slug);
      if (!term) return notFound(templates, ctx, path);
      const docs = await db.query<Doc>(
        `SELECT d.id, d.slug, d.title, d.number, d.type, d.excerpt, d.created
           FROM documents d JOIN document_terms dt ON dt.document_id = d.id
          WHERE dt.term_id = ? AND d.status = 'published'
          ORDER BY d.created DESC, d.id DESC
          LIMIT 200`,
        [term.id],
      );
      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, 'archive', term.name, {
          ...ctx,
          query: '',
          term: { ...term, url: termUrl(base, term) },
          posts: docs.map((d) => docView(base, d)),
          count: docs.length,
        }),
      };
    }

    case 'collection': {
      const collection = await getCollectionBySlug(db, route.slug);
      if (!collection) return notFound(templates, ctx, path);
      const nodes = await subtree(db, 0, {
        collectionId: collection.id,
        publishedOnly: true,
      });
      const tree = flattenTree(nodes, base);
      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, 'collection', collection.title, {
          ...ctx,
          query: '',
          collection,
          tree,
          count: tree.length,
        }),
      };
    }

    case 'part': {
      const doc = await getPublishedBySlug(db, route.slug);
      if (!doc) return notFound(templates, ctx, path);
      const part = await getPartByAnchor(db, doc.id, route.anchor);
      if (!part) return notFound(templates, ctx, path);
      const related = (await relatedParts(db, part.id, { limit: 6 })).map((r) => ({
        url: partUrl(base, r.slug, r.anchor),
        title: r.title,
        text: clip(r.text, 140),
        score: r.confidence.toFixed(2),
      }));
      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, 'part', `${doc.title} — ${part.anchor}`, {
          ...ctx,
          query: '',
          post: docView(base, doc),
          part: { kind: part.kind, anchor: part.anchor },
          parts: renderParts(templates, [part], {
            site: ctx.site,
            base,
            unlocked: false,
          }),
          related,
        }),
      };
    }

    case 'document': {
      const doc = await getPublishedBySlug(db, route.slug);
      if (!doc) return notFound(templates, ctx, path);

      const terms = await termsForDocument(db, doc.id);
      const view = docView(base, doc, terms);
      const rendered = await renderDocumentParts(db, templates, doc, ctx, options);
      const children = (await childrenOf(db, doc.id))
        .filter((child) => child.status === 'published')
        .map((child) => docView(base, child));
      const ancestors = (await ancestorsOf(db, doc.id)).map((a) => docView(base, a));
      const related = (await relatedDocuments(db, doc.id, { limit: 8 })).map((r) => ({
        url: docUrl(base, r),
        title: r.title,
        number: r.number,
        relation: r.relation.replace(/_/g, ' '),
        // A manual link has no meaningful confidence; showing 0.00 would be noise.
        score: r.origin === 'tfidf' ? r.confidence.toFixed(2) : '',
      }));

      return {
        kind: 'html',
        status: 200,
        mime: HTML_MIME,
        body: compose(templates, doc.type === 'page' ? 'page' : 'single', doc.title, {
          ...ctx,
          query: '',
          post: view,
          terms: view.terms ?? [],
          parts: rendered.html,
          children,
          breadcrumbs: ancestors,
          related,
        }),
      };
    }
  }
}

/**
 * Render a draft as if it were published — the admin's preview pane. Bypasses the status filter
 * that renderPath deliberately applies, and never touches the route table.
 */
export async function renderPreview(db: Db, doc: Doc, options: RenderOptions): Promise<string> {
  const templates = await loadTemplates(db);
  const ctx = await siteContext(db, options);
  const terms = await termsForDocument(db, doc.id);
  const view = docView(options.base, doc, terms);
  const rendered = await renderDocumentParts(db, templates, doc, ctx, options);
  return compose(templates, doc.type === 'page' ? 'page' : 'single', doc.title, {
    ...ctx,
    query: '',
    post: view,
    terms: view.terms ?? [],
    parts: rendered.html,
    children: [],
    breadcrumbs: [],
    related: [],
  });
}
