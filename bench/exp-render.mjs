// Experiment: cheaper renderers with byte-identical output.
//
//   html   current: map(render).join('') per child list, Object.entries per tag
//   html'  appends into one string, loops over attribute keys
//   react  current: rest-destructures attributes, then deepRender copies them again
//   react' builds the props object in one pass (same key order: other keys,
//          then className), children rendered in a plain loop
import { createRequire } from 'node:module';
import { loadMarkdoc, prepare, React } from './lib/pipeline.mjs';
import { compare, report } from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const M = loadMarkdoc('candidate');
const MarkdownIt = require('markdown-it');
const { escapeHtml } = MarkdownIt().utils;

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
const isTag = (t) => t != null && t.$$mdtype === 'Tag';

function htmlFast(node) {
  if (typeof node === 'string' || typeof node === 'number')
    return escapeHtml(String(node));
  if (Array.isArray(node)) {
    let out = '';
    for (let i = 0; i < node.length; i++) out += htmlFast(node[i]);
    return out;
  }
  if (node === null || typeof node !== 'object' || !isTag(node)) return '';
  const { name, attributes } = node;
  const children = node.children === undefined ? [] : node.children;
  if (!name) return htmlFast(children);
  let out = '<' + name;
  if (attributes != null)
    for (const k of Object.keys(attributes))
      out +=
        ' ' + k.toLowerCase() + '="' + escapeHtml(String(attributes[k])) + '"';
  out += '>';
  if (voidElements.has(name)) return out;
  if (children.length) out += htmlFast(children);
  return out + '</' + name + '>';
}

function tagName(name, components) {
  return typeof name !== 'string'
    ? name
    : name[0] !== name[0].toUpperCase()
    ? name
    : components instanceof Function
    ? components(name)
    : components[name];
}

function reactFast(
  node,
  React,
  { components = {}, resolveTagName = tagName } = {}
) {
  function deepRender(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => deepRender(item));
    if (value.$$mdtype === 'Tag') return render(value);
    const output = {};
    for (const k of Object.keys(value)) output[k] = deepRender(value[k]);
    return output;
  }
  function render(node) {
    if (Array.isArray(node)) {
      const args = [React.Fragment, null];
      for (let i = 0; i < node.length; i++) args.push(render(node[i]));
      return React.createElement.apply(React, args);
    }
    if (node === null || typeof node !== 'object' || !isTag(node)) return node;
    const { name } = node;
    const attributes = node.attributes === undefined ? {} : node.attributes;
    const children = node.children === undefined ? [] : node.children;
    let props = null;
    let className;
    for (const k of Object.keys(attributes)) {
      if (k === 'class') {
        className = attributes[k];
        continue;
      }
      (props ??= {})[k] = deepRender(attributes[k]);
    }
    if (className) (props ??= {}).className = deepRender(className);
    const args = [resolveTagName(name, components), props];
    for (let i = 0; i < children.length; i++) args.push(render(children[i]));
    return React.createElement.apply(React, args);
  }
  return render(node);
}

// One-pass props, but keep the spread call (apply was the slow part).
function reactSpread(
  node,
  React,
  { components = {}, resolveTagName = tagName } = {}
) {
  function deepRender(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => deepRender(item));
    if (value.$$mdtype === 'Tag') return render(value);
    const output = {};
    for (const k of Object.keys(value)) output[k] = deepRender(value[k]);
    return output;
  }
  function render(node) {
    if (Array.isArray(node))
      return React.createElement(React.Fragment, null, ...node.map(render));
    if (node === null || typeof node !== 'object' || !isTag(node)) return node;
    const attributes = node.attributes === undefined ? {} : node.attributes;
    const children = node.children === undefined ? [] : node.children;
    let props = null;
    let className;
    for (const k of Object.keys(attributes)) {
      if (k === 'class') {
        className = attributes[k];
        continue;
      }
      (props ??= {})[k] = deepRender(attributes[k]);
    }
    if (className) (props ??= {}).className = deepRender(className);
    return React.createElement(
      resolveTagName(node.name, components),
      props,
      ...children.map(render)
    );
  }
  return render(node);
}

const shape = (el) =>
  JSON.stringify(el, (k, v) => (typeof v === 'function' ? v.name || 'fn' : v));

for (const corpusName of ['pages', 'descriptions']) {
  const s = prepare(M, corpusName);
  for (const t of s.trees) {
    if (htmlFast(t) !== M.renderers.html(t)) throw new Error('html mismatch');
    if (
      shape(reactFast(t, React, { components: s.components })) !==
      shape(M.renderers.react(t, React, { components: s.components }))
    )
      throw new Error('react mismatch');
    if (
      shape(reactSpread(t, React, { components: s.components })) !==
      shape(M.renderers.react(t, React, { components: s.components }))
    )
      throw new Error('react spread mismatch');
  }
  report(
    `${corpusName.toUpperCase()} — render`,
    compare(
      {
        html: () => {
          for (const t of s.trees) M.renderers.html(t);
        },
        "html'": () => {
          for (const t of s.trees) htmlFast(t);
        },
        react: () => {
          for (const t of s.trees)
            M.renderers.react(t, React, { components: s.components });
        },
        "react'": () => {
          for (const t of s.trees)
            reactFast(t, React, { components: s.components });
        },
        "react'' (spread)": () => {
          for (const t of s.trees)
            reactSpread(t, React, { components: s.components });
        },
      },
      { rounds: 11, warmup: 3 }
    )
  );
}
