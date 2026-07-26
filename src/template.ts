// A mustache-shaped template language, just big enough to write a theme in.
//
// Deliberately tiny and dependency-free, because templates are *data* here — they come out of
// the `templates` table, which means they are also user-editable in the admin. That makes the
// escaping rules load-bearing rather than cosmetic:
//
//   {{x}}     interpolate, HTML-escaped   — the safe default
//   {{{x}}}   interpolate raw             — used only for post bodies, which are HTML by design
//
// Sections:
//
//   {{#each posts}} … {{/each}}     iterate an array; `.` is the current item
//   {{#if draft}} … {{else}} … {{/if}}   truthiness, with optional else
//
// Lookups are dotted (`{{post.title}}`) and walk an explicit context stack, so an `each` body
// can still reach outer scope. Unknown paths render empty rather than throwing — a template is
// content, and a typo in it should not take the page down.

export type Scope = unknown;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string; raw: boolean }
  | { kind: 'each'; path: string; body: Node[] }
  | { kind: 'if'; path: string; body: Node[]; otherwise: Node[] };

type Tag =
  | { t: 'text'; value: string }
  | { t: 'var'; path: string; raw: boolean }
  | { t: 'each'; path: string }
  | { t: 'if'; path: string }
  | { t: 'else' }
  | { t: 'endEach' }
  | { t: 'endIf' };

// One regex, one pass. The triple-brace alternative has to come first so `{{{x}}}` is not
// mis-lexed as `{{` + `{x}`.
const TAG = /\{\{\{\s*([^}\s]+)\s*\}\}\}|\{\{\s*([#/][a-z]+|else)?\s*([^}\s]*)\s*\}\}/g;

function lex(source: string): Tag[] {
  const tags: Tag[] = [];
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const at = m.index;
    if (at > last) tags.push({ t: 'text', value: source.slice(last, at) });
    last = at + m[0].length;

    const [, triple, keyword, path] = m;
    if (triple !== undefined) {
      tags.push({ t: 'var', path: triple, raw: true });
      continue;
    }
    switch (keyword) {
      case '#each':
        tags.push({ t: 'each', path: path ?? '' });
        break;
      case '#if':
        tags.push({ t: 'if', path: path ?? '' });
        break;
      case 'else':
        tags.push({ t: 'else' });
        break;
      case '/each':
        tags.push({ t: 'endEach' });
        break;
      case '/if':
        tags.push({ t: 'endIf' });
        break;
      default:
        // A bare {{x}}. `keyword` is undefined here; an empty path means `{{}}`, which we drop.
        if (path) tags.push({ t: 'var', path, raw: false });
    }
  }
  if (last < source.length) tags.push({ t: 'text', value: source.slice(last) });
  return tags;
}

/** Recursive descent over the tag stream. `stop` names the closers that end this block. */
function parse(tags: Tag[], cursor: { i: number }, stop: Tag['t'][] = []): Node[] {
  const nodes: Node[] = [];
  while (cursor.i < tags.length) {
    const tag = tags[cursor.i];
    if (!tag) break;
    if (stop.includes(tag.t)) break;
    cursor.i++;

    switch (tag.t) {
      case 'text':
        nodes.push({ kind: 'text', value: tag.value });
        break;
      case 'var':
        nodes.push({ kind: 'var', path: tag.path, raw: tag.raw });
        break;
      case 'each': {
        const body = parse(tags, cursor, ['endEach']);
        cursor.i++; // consume {{/each}}
        nodes.push({ kind: 'each', path: tag.path, body });
        break;
      }
      case 'if': {
        const body = parse(tags, cursor, ['endIf', 'else']);
        let otherwise: Node[] = [];
        if (tags[cursor.i]?.t === 'else') {
          cursor.i++; // consume {{else}}
          otherwise = parse(tags, cursor, ['endIf']);
        }
        cursor.i++; // consume {{/if}}
        nodes.push({ kind: 'if', path: tag.path, body, otherwise });
        break;
      }
      default:
        // A stray {{else}} / {{/each}} / {{/if}} with no opener. Ignore it rather than throw.
        break;
    }
  }
  return nodes;
}

/** Walk the context stack outward-in looking for a dotted path. `.` is the current scope. */
function lookup(stack: Scope[], path: string): unknown {
  if (path === '.') return stack[stack.length - 1];
  const parts = path.split('.');
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    let value: unknown = stack[depth];
    let matched = true;
    for (const part of parts) {
      if (value !== null && typeof value === 'object' && part in (value as object)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return value;
  }
  return undefined;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  return String(value);
}

function render(nodes: Node[], stack: Scope[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'var': {
        const text = stringify(lookup(stack, node.path));
        out += node.raw ? text : escapeHtml(text);
        break;
      }
      case 'each': {
        const list = lookup(stack, node.path);
        if (Array.isArray(list)) {
          for (const item of list) out += render(node.body, [...stack, item]);
        }
        break;
      }
      case 'if': {
        const value = lookup(stack, node.path);
        const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
        out += render(truthy ? node.body : node.otherwise, stack);
        break;
      }
    }
  }
  return out;
}

/** Compile once, render many — the admin re-renders a preview on every keystroke. */
export function compile(source: string): (data: Record<string, unknown>) => string {
  const nodes = parse(lex(source), { i: 0 });
  return (data) => render(nodes, [data]);
}

export function renderTemplate(source: string, data: Record<string, unknown>): string {
  return compile(source)(data);
}
