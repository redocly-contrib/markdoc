import Tag from '../tag';
import type { RenderableTreeNodes } from '../types';
const HTML_ESCAPE_TEST_RE = /[&<>"]/;
const HTML_ESCAPE_REPLACE_RE = /[&<>"]/g;
const HTML_REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

// markdown-it's `escapeHtml`, which this renderer has always used.
function escapeHtml(str: string): string {
  if (HTML_ESCAPE_TEST_RE.test(str))
    return str.replace(HTML_ESCAPE_REPLACE_RE, (ch) => HTML_REPLACEMENTS[ch]);
  return str;
}

// HTML elements that do not have a matching close tag
// Defined in the HTML standard: https://html.spec.whatwg.org/#void-elements
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export default function render(node: RenderableTreeNodes): string {
  if (typeof node === 'string' || typeof node === 'number')
    return escapeHtml(String(node));

  // Appending into one string is cheaper than `map(render).join('')`.
  if (Array.isArray(node)) {
    let output = '';
    for (let i = 0; i < node.length; i++) output += render(node[i]);
    return output;
  }

  if (node === null || typeof node !== 'object' || !Tag.isTag(node)) return '';

  const { name, attributes, children = [] } = node;

  if (!name) return render(children);

  let output = '<' + name;
  if (attributes != null)
    for (const k of Object.keys(attributes))
      output +=
        ' ' + k.toLowerCase() + '="' + escapeHtml(String(attributes[k])) + '"';
  output += '>';

  if (voidElements.has(name)) return output;

  if (children.length) output += render(children);
  output += '</' + name + '>';

  return output;
}
