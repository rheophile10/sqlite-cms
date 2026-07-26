// Link/preview cards — Open Graph and Twitter.
//
// Where the bytes live, since that was the question: **in SQLite, as media**. A card is one ~100 KB
// PNG per shareable thing. It belongs to the content, it should replicate with the database, and
// `/p/media/<slug>` already serves it. The file VFS (`idb-vfs-store`) earns its keep for streaming a
// 2 GB video with range reads; putting a preview image there would buy nothing and split the media
// library across two stores. The *definition* — title, description, which image — is a `cards` row.
//
// The part that matters more than the storage question, and is easy to get wrong:
//
//   **A crawler will never see a card this renderer produces.**
//
// Twitter, Slack, Facebook and iMessage fetch a URL with a plain HTTP client. They do not run
// JavaScript, and a Service Worker is a *browser* facility — it is not installed for them and never
// intercepts their request. So a preview that exists only inside our rendered HTML is invisible to
// exactly the audience it is for.
//
// Which means cards have two jobs, and both are needed:
//
//   1. `cardFor()` puts the tags in the served HTML, so view-source is honest and a browser
//      sharing-extension can read them.
//   2. A build step must ALSO write static files — the image, and a small HTML stub per permalink
//      carrying the same tags — because that is the only thing a crawler can see. See
//      rheophile-web-cms/og.mjs.
//
// Without (2) the card is decoration. Anyone adding cards to a new site should read that twice.
import type { Db } from '../engine/db.js';
import { getSetting } from './settings.js';
import { flattenHtml } from './schema.js';
import type { Doc } from './documents.js';

export type CardScope = 'site' | 'document';

/** Twitter's card types. `summary_large_image` is the wide one; `summary` is the small square. */
export type CardKind = 'summary_large_image' | 'summary';

export interface Card {
  scope: CardScope;
  ref: number;
  kind: CardKind;
  title: string;
  description: string;
  /** A media slug, or an absolute URL for an image that is not in the database. */
  image: string;
  image_alt: string;
  updated: string;
  metadata: string | null;
}

export interface CardEdits {
  kind?: CardKind;
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
  metadata?: Record<string, unknown> | null;
}

const COLUMNS = `scope, ref, kind, title, description, image, image_alt, updated, metadata`;

export async function setCard(
  db: Db,
  scope: CardScope,
  ref: number,
  edits: CardEdits,
): Promise<void> {
  const existing = await getCard(db, scope, ref);
  await db.query(
    `INSERT INTO cards (scope, ref, kind, title, description, image, image_alt, updated, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(scope, ref) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, description = excluded.description,
       image = excluded.image, image_alt = excluded.image_alt, updated = excluded.updated,
       metadata = excluded.metadata`,
    [
      scope,
      ref,
      edits.kind ?? existing?.kind ?? 'summary_large_image',
      edits.title ?? existing?.title ?? '',
      edits.description ?? existing?.description ?? '',
      edits.image ?? existing?.image ?? '',
      edits.imageAlt ?? existing?.image_alt ?? '',
      edits.metadata === undefined
        ? (existing?.metadata ?? null)
        : edits.metadata
          ? JSON.stringify(edits.metadata)
          : null,
    ],
  );
}

export async function getCard(db: Db, scope: CardScope, ref: number): Promise<Card | undefined> {
  return (
    await db.query<Card>(`SELECT ${COLUMNS} FROM cards WHERE scope = ? AND ref = ?`, [scope, ref])
  )[0];
}

export async function deleteCard(db: Db, scope: CardScope, ref: number): Promise<void> {
  await db.query(`DELETE FROM cards WHERE scope = ? AND ref = ?`, [scope, ref]);
}

export async function listCards(db: Db): Promise<Card[]> {
  return db.query<Card>(`SELECT ${COLUMNS} FROM cards ORDER BY scope, ref`);
}

/** Everything a `<head>` needs. Absolute URLs, because a crawler has no base to resolve against. */
export interface ResolvedCard {
  kind: CardKind;
  title: string;
  description: string;
  /** Absolute, or '' when there is no image to offer. */
  image: string;
  imageAlt: string;
  /** Absolute canonical URL for the thing being shared, or ''. */
  url: string;
  siteName: string;
  type: 'website' | 'article';
}

export interface CardContext {
  /** Content root with trailing slash, e.g. `/p/`. */
  base: string;
  /**
   * Public origin, e.g. `https://rheophile.ca`. Without it URLs cannot be made absolute and the
   * card is emitted without them — better than emitting a relative `og:image`, which no crawler
   * will resolve.
   */
  origin?: string;
}

const absolute = (origin: string | undefined, path: string): string => {
  if (!path) return '';
  if (/^[a-z]+:/i.test(path)) return path;
  return origin ? `${origin.replace(/\/+$/, '')}${path}` : '';
};

/**
 * The card for a document, or for the site when `doc` is omitted.
 *
 * Override-then-fallback at the field level, not the row level: a document that sets only a title
 * still inherits the site's image. Anything still missing is derived from the document itself, so a
 * site gets usable cards without anybody authoring one.
 */
export async function cardFor(
  db: Db,
  context: CardContext,
  doc?: Doc,
  /** Flattened body text, if the caller already has it — saves re-reading the parts. */
  bodyText?: string,
): Promise<ResolvedCard> {
  const site = await getCard(db, 'site', 0);
  const own = doc ? await getCard(db, 'document', doc.id) : undefined;

  const siteName = (await getSetting(db, 'site.title')) || 'A SQLite Site';
  const tagline = await getSetting(db, 'site.tagline');

  const pick = (...values: (string | undefined)[]): string =>
    values.find((value) => value !== undefined && value !== '') ?? '';

  const description = pick(
    own?.description,
    doc?.excerpt,
    // Last resort: the opening of the body. Trimmed to what a preview actually shows.
    bodyText ? flattenHtml(bodyText).slice(0, 200) : undefined,
    site?.description,
    tagline,
  );

  const imageSlug = pick(own?.image, site?.image);
  const path = doc ? `${context.base}${encodeURIComponent(doc.slug)}/` : context.base;

  return {
    kind: (own?.kind ?? site?.kind ?? 'summary_large_image') as CardKind,
    title: pick(own?.title, doc?.title, site?.title, siteName),
    description,
    image: absolute(
      context.origin,
      /^[a-z]+:/i.test(imageSlug) ? imageSlug : imageSlug ? `${context.base}media/${imageSlug}` : '',
    ),
    imageAlt: pick(own?.image_alt, site?.image_alt, pick(own?.title, doc?.title)),
    url: absolute(context.origin, path),
    siteName,
    type: doc ? 'article' : 'website',
  };
}

/** Seed a site card from the settings, so there is something rather than nothing. */
export async function seedSiteCard(db: Db): Promise<void> {
  if (await getCard(db, 'site', 0)) return;
  await setCard(db, 'site', 0, {
    title: (await getSetting(db, 'site.title')) || 'A SQLite Site',
    description: await getSetting(db, 'site.tagline'),
  });
}
