// The public surface, for using this as an engine rather than running it as an app.
//
// `sqlite-cms` is a private app *and* the thing that renders a site out of SQLite, and those are
// separable: `admin/main.ts` is one consumer of everything below, and a read-only front end for a
// real weblog is another. Exporting the seam rather than copying the files is the same call
// browser-crypto made — a copy drifts, and there is no way to tell which copy is right.
//
//   import { openDatabase, migrate, seedTheme, createTransport, renderPath } from 'sqlite-cms';
//
// Consumers resolve this through a path alias rather than package resolution (see the vite and
// tsconfig setup in rheophile-web-cms), because the export is TypeScript source: there is no build
// step here to produce .js, and adding one would mean two ways to be out of date.

// ── engine ───────────────────────────────────────────────────────────────────────────────────
export { openDatabase } from './engine/db.js';
export type { Db, OpenOptions, Row, SqlValue } from './engine/db.js';

// ── schema and migration ─────────────────────────────────────────────────────────────────────
export { migrate, migrateFromV1, reindex, pageStats, flattenHtml, SCHEMA } from './model/schema.js';

// ── documents and the hierarchy ──────────────────────────────────────────────────────────────
export {
  ancestorsOf,
  childrenOf,
  countDocuments,
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentBySlug,
  getPublishedBySlug,
  listDocuments,
  listOrdered,
  newId,
  reorder,
  searchDocuments,
  slugify,
  subtree,
  toMatchExpression,
  uniqueSlug,
  updateDocument,
} from './model/documents.js';
export type {
  Doc,
  DocEdits,
  DocHit,
  DocNode,
  DocumentStatus,
  DocumentType,
  ListOptions,
  NewDoc,
  Visibility,
} from './model/documents.js';

// ── parts ────────────────────────────────────────────────────────────────────────────────────
export {
  addPart,
  allParts,
  childPartsOf,
  countParts,
  deletePart,
  deriveText,
  documentText,
  getPart,
  getPartByAnchor,
  listParts,
  partData,
  reorderPart,
  searchParts,
  setParts,
  updatePart,
} from './model/parts.js';
export type { Part, PartHit, PartInput, PartKind } from './model/parts.js';

// ── collections, taxonomy, media, settings ───────────────────────────────────────────────────
export {
  createCollection,
  deleteCollection,
  ensureCollection,
  getCollection,
  getCollectionBySlug,
  listCollections,
  updateCollection,
} from './model/collections.js';
export type { Collection, CollectionKind, CollectionWithCount } from './model/collections.js';

export {
  ensureTerm,
  getTermBySlug,
  listTerms,
  parseTermList,
  pruneOrphanTerms,
  setDocumentTerms,
  termsForDocument,
} from './model/taxonomy.js';
export type { Term, TermKind, TermWithCount } from './model/taxonomy.js';

export {
  addMedia,
  addMediaFile,
  countMedia,
  deleteMedia,
  formatBytes,
  getMediaBySlug,
  getMediaRow,
  listMedia,
} from './model/media.js';
export type { MediaBlob, MediaRow } from './model/media.js';

export { DEFAULT_SETTINGS, getSetting, seedSettings, setSetting } from './model/settings.js';

export { cardFor, deleteCard, getCard, listCards, seedSiteCard, setCard } from './model/cards.js';
export type { Card, CardContext, CardEdits, CardKind, CardScope, ResolvedCard } from './model/cards.js';

// ── relations and relatedness ────────────────────────────────────────────────────────────────
export {
  clearByOrigin,
  countRelations,
  link,
  relatedDocuments,
  relatedParts,
  relationMetadata,
  relationsFrom,
  unlink,
} from './model/relations.js';
export type {
  Relation,
  RelatedDoc,
  RelatedPart,
  RelationOrigin,
  RelationScope,
  RelationType,
} from './model/relations.js';

export { computeSimilar, cosineNeighbours, tokenize } from './model/similarity.js';
export type { ComputeOptions, ComputeReport, Neighbour, SimilarityOptions } from './model/similarity.js';

// ── querying by URL parameter ────────────────────────────────────────────────────────────────
export {
  EMPTY_QUERY,
  groupByDocument,
  isEmptyQuery,
  parseQuery,
  queryToParams,
  queryToString,
  runQuery,
  toggleTerm,
} from './model/query.js';
export type {
  FacetValue,
  GroupedDocument,
  Grouping,
  Query,
  QueryPart,
  QueryResult,
  Sort,
  TermMode,
} from './model/query.js';

// ── view ─────────────────────────────────────────────────────────────────────────────────────
export { compile, escapeHtml, renderTemplate } from './view/template.js';
export {
  DEFAULT_TEMPLATES,
  PAGE_TEMPLATES,
  TEMPLATE_ORDER,
  getTemplate,
  loadTemplates,
  resetTemplate,
  seedTheme,
  setTemplate,
} from './view/theme.js';
export type { PageTemplateName } from './view/theme.js';

export { BUILTIN_WIDGETS, DEFAULT_WIDGETS, renderPart, renderParts, widgetTemplateName } from './view/widgets.js';
export type { WidgetContext } from './view/widgets.js';

export { clip, flattenTree, formatDate, renderPath, renderPreview, routeOf } from './view/render.js';
export type { RenderOptions, Route, Served, Viewer } from './view/render.js';

// ── serving ──────────────────────────────────────────────────────────────────────────────────
export { contentBase, createTransport, isSitePath } from './serve/transport.js';
export type { SiteContext, Transport, TransportMode } from './serve/transport.js';
