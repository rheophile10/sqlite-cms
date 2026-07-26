// Widget renderers: part → HTML.
//
// A part's `kind` names a template stored in the database as `widget:<kind>`, and the part's
// `data` JSON is that template's context. So "tag raw data to a renderer with specific HTML" is
// literally a row lookup, and adding a widget kind means adding a row — no code, no rebuild.
//
// Two things are added to every render context beyond the payload itself:
//
//   anchor / kind / ordinal   so a widget can mark itself up as a deep-link target
//   site / base               so a widget can build URLs into the site it belongs to
//
// An unknown kind falls through to `widget:html`, which emits `data.html` verbatim. That makes
// the fallback total: any part, however malformed its kind, renders as something.
import { renderTemplate } from './template.js';
import { partData, type Part } from '../model/parts.js';

/** Kinds with a built-in renderer. Others are legal; they just need a template row. */
export const BUILTIN_WIDGETS = [
  'prose',
  'heading',
  'html',
  'code',
  'quote',
  'list',
  'table',
  'callout',
  'figure',
  'video',
  'story',
  'raw',
  'sealed',
] as const;

export const widgetTemplateName = (kind: string): string => `widget:${kind}`;

export interface WidgetContext {
  /** Site-level context — the same object the page templates receive. */
  site: unknown;
  /** Content root with trailing slash, for building URLs to media and other documents. */
  base: string;
  /** True when the reader holds a key for this document; sealed widgets branch on it. */
  unlocked?: boolean;
}

/**
 * Render one part.
 *
 * `data` is spread into the context rather than nested under a key so a template reads
 * `{{{html}}}` instead of `{{{data.html}}}` — templates are content here, and the shorter form is
 * what an author will actually write. The reserved names below win on collision.
 */
export function renderPart(
  templates: Record<string, string>,
  part: Part,
  context: WidgetContext,
): string {
  const data = partData(part);
  const template =
    templates[widgetTemplateName(part.kind)] ?? templates[widgetTemplateName('html')] ?? '';
  return renderTemplate(template, {
    ...data,
    anchor: part.anchor,
    kind: part.kind,
    ordinal: part.ordinal,
    partId: part.id,
    site: context.site,
    base: context.base,
    unlocked: context.unlocked ?? false,
  });
}

/** Render an ordered list of parts into one HTML string. */
export function renderParts(
  templates: Record<string, string>,
  parts: readonly Part[],
  context: WidgetContext,
): string {
  return parts.map((part) => renderPart(templates, part, context)).join('\n');
}

// ── Built-in widget templates ────────────────────────────────────────────────────────────────
//
// Seeded into `templates` by theme.ts. Every one of them is editable in the admin afterwards,
// which is the point: the renderer for a kind of content is content.

const PROSE = `<div class="part prose" id="{{anchor}}">{{{html}}}</div>`;

const HEADING = `<h{{level}} class="part heading" id="{{anchor}}">{{text}}</h{{level}}>`;

const HTML_PASSTHROUGH = `<div class="part raw" id="{{anchor}}">{{{html}}}</div>`;

const CODE = `<figure class="part code" id="{{anchor}}">
  {{#if caption}}<figcaption>{{caption}}</figcaption>{{/if}}
  <pre data-lang="{{lang}}"><code>{{code}}</code></pre>
</figure>`;

const QUOTE = `<blockquote class="part quote" id="{{anchor}}">
  {{{html}}}
  {{#if cite}}<cite>{{cite}}</cite>{{/if}}
</blockquote>`;

const LIST = `<div class="part list" id="{{anchor}}">
  {{#if title}}<p class="list-title">{{title}}</p>{{/if}}
  <ul>{{#each items}}<li>{{{.}}}</li>{{/each}}</ul>
</div>`;

const TABLE = `<figure class="part table" id="{{anchor}}">
  {{#if caption}}<figcaption>{{caption}}</figcaption>{{/if}}
  <table>
    {{#if columns}}<thead><tr>{{#each columns}}<th>{{.}}</th>{{/each}}</tr></thead>{{/if}}
    <tbody>{{#each rows}}<tr>{{#each .}}<td>{{{.}}}</td>{{/each}}</tr>{{/each}}</tbody>
  </table>
</figure>`;

const CALLOUT = `<aside class="part callout {{tone}}" id="{{anchor}}">
  {{#if title}}<p class="callout-title">{{title}}</p>{{/if}}
  {{{html}}}
</aside>`;

const FIGURE = `<figure class="part figure" id="{{anchor}}">
  <img src="{{base}}media/{{src}}" alt="{{alt}}">
  {{#if caption}}<figcaption>{{{caption}}}</figcaption>{{/if}}
</figure>`;

// Media is referenced by slug and resolved against the content base, so the same row works at
// file:// (rewritten to a data: URI) and when hosted (fetched through the Service Worker).
const VIDEO = `<figure class="part video" id="{{anchor}}">
  <video controls preload="metadata"{{#if poster}} poster="{{base}}media/{{poster}}"{{/if}}>
    <source src="{{base}}media/{{src}}" type="{{mime}}">
  </video>
  {{#if caption}}<figcaption>{{{caption}}}</figcaption>{{/if}}
</figure>`;

// The paired narration-plus-clip shape used throughout the rheophile-web how-to posts.
const STORY = `<section class="part story" id="{{anchor}}">
  <div class="story-text">
    {{#if step}}<p class="story-step">{{step}}</p>{{/if}}
    {{#if title}}<h3>{{title}}</h3>{{/if}}
    {{{html}}}
  </div>
  {{#if src}}
  <div class="story-media">
    <video controls preload="metadata"{{#if poster}} poster="{{base}}media/{{poster}}"{{/if}}>
      <source src="{{base}}media/{{src}}" type="{{mime}}">
    </video>
  </div>
  {{/if}}
</section>`;

// A whole self-contained document, embedded.
//
// For an entry that is not prose at all — an interactive piece that brings its own stylesheet and
// its own JavaScript. Rendering that inline would let its CSS restyle the page around it and its
// scripts reach the site's own document, so it goes in a sandboxed srcdoc frame instead: scripts
// run, nothing leaks either way, and the frame has an opaque origin because `allow-same-origin` is
// deliberately absent.
//
// `srcdoc` is interpolated *escaped* — it is an attribute value, and `{{ }}` is exactly right for
// one. The height listener is installed once per page and matches frames by contentWindow, which is
// the only handle that works across the sandbox boundary.
const RAW = `<div class="part raw" id="{{anchor}}">
  {{#if title}}<p class="raw-title">{{title}}</p>{{/if}}
  <iframe class="raw-frame" title="{{#if title}}{{title}}{{else}}Embedded document{{/if}}"
          sandbox="allow-scripts allow-popups" srcdoc="{{srcdoc}}"></iframe>
  {{#if caption}}<p class="raw-caption">{{{caption}}}</p>{{/if}}
</div>
<script>
(function () {
  if (window.__cmsRawHeights) return;
  window.__cmsRawHeights = true;
  addEventListener('message', function (ev) {
    if (!ev.data || ev.data.type !== 'cms:raw-height') return;
    var frames = document.querySelectorAll('iframe.raw-frame');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === ev.source) {
        frames[i].style.height = Math.max(120, ev.data.height) + 'px';
        return;
      }
    }
  });
})();
</script>`;

// A part whose content is encrypted. The ciphertext is never emitted — there is no reason for it
// to reach the page, and putting it in the DOM would invite somebody to think it is protected
// there. When a key is available the renderer is handed the decrypted part instead of this one.
const SEALED = `<aside class="part sealed" id="{{anchor}}">
  <p class="sealed-title">Encrypted</p>
  <p>{{#if hint}}{{hint}}{{else}}This section is sealed. Load a private key that it was encrypted for to read it.{{/if}}</p>
</aside>`;

export const DEFAULT_WIDGETS: Record<string, string> = {
  'widget:prose': PROSE,
  'widget:heading': HEADING,
  'widget:html': HTML_PASSTHROUGH,
  'widget:code': CODE,
  'widget:quote': QUOTE,
  'widget:list': LIST,
  'widget:table': TABLE,
  'widget:callout': CALLOUT,
  'widget:figure': FIGURE,
  'widget:video': VIDEO,
  'widget:story': STORY,
  'widget:raw': RAW,
  'widget:sealed': SEALED,
};
