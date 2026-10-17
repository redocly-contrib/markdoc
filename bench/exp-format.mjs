// Experiment: smaller stored AST formats that revive to the exact same Nodes.
//
//   json      what compact() + JSON.stringify store today
//   lean      still one JSON object per node, but nodes are recognised by
//             position (no "$$mdtype"), empty attributes/children and
//             default fields are left out, and inline is a short flag
//   packed    a node is an array [head, attributes?, ...children]; head is the
//             type ("paragraph"), "%name" for a tag, prefixed with "~" when
//             inline; a plain inline text node is just its string. Rare fields
//             (errors, annotations, slots, location, a tag on a non-tag node)
//             go under "$"-keys in the attributes object, which can never
//             clash: attribute names are identifiers.
//   packed+codes  packed, with the common types as one uppercase letter
//
// Every format is checked to revive to Nodes that serialize identically to
// Ast.fromJSON(json) and transform to the identical renderable tree.
import zlib from 'node:zlib';
import { loadMarkdoc, prepare } from './lib/pipeline.mjs';
import { compare, report, fmtBytes } from './lib/harness.mjs';

const M = loadMarkdoc('candidate');
const { Node, Variable, Function: Fn } = M.Ast;

// ---------------------------------------------------------------- helpers
const isEmpty = (o) => {
  for (const _ in o) return false;
  return true;
};

// Revive Variable/Function (and any Node) values nested in attribute values.
function reviveValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveValue(value[i]);
    return value;
  }
  for (const k in value) value[k] = reviveValue(value[k]);
  switch (value.$$mdtype) {
    case 'Node':
      return Object.assign(new Node(), value);
    case 'Variable':
      return Object.assign(new Variable(), value);
    case 'Function':
      return Object.assign(new Fn(), value);
  }
  return value;
}

// ---------------------------------------------------------------- lean
function leanEncode(n) {
  const o = { t: n.type };
  if (n.tag !== undefined) o.g = n.tag;
  if (n.inline) o.i = 1;
  if (!isEmpty(n.attributes)) o.a = n.attributes;
  if (n.children.length) o.c = n.children.map(leanEncode);
  if (n.errors.length) o.e = n.errors;
  if (n.annotations.length) o.n = n.annotations;
  if (!isEmpty(n.slots))
    o.s = Object.fromEntries(
      Object.entries(n.slots).map(([k, v]) => [k, leanEncode(v)])
    );
  if (n.location) o.l = n.location;
  return o;
}
function leanDecode(o) {
  const node = new Node(
    o.t,
    o.a === undefined ? {} : reviveValue(o.a),
    o.c === undefined ? [] : o.c.map(leanDecode),
    o.g
  );
  if (o.i) node.inline = true;
  if (o.e) node.errors = o.e;
  if (o.n) node.annotations = reviveValue(o.n);
  if (o.s) for (const k in o.s) node.slots[k] = leanDecode(o.s[k]);
  if (o.l) node.location = o.l;
  return node;
}

// ---------------------------------------------------------------- packed
const CODES = {
  text: 'T',
  paragraph: 'P',
  softbreak: 'B',
  item: 'I',
  list: 'L',
  code: 'C',
  heading: 'H',
  strong: 'S',
  em: 'E',
  link: 'A',
  td: 'D',
  tr: 'R',
  th: 'X',
  tag: 'G',
  fence: 'F',
  blockquote: 'Q',
  hr: 'Z',
  image: 'M',
  table: 'W',
  thead: 'U',
  tbody: 'Y',
  hardbreak: 'K',
  document: 'O',
  comment: 'N',
  error: 'V',
};
const DECODE = Object.fromEntries(
  Object.entries(CODES).map(([k, v]) => [v, k])
);

function makePacked(codes) {
  const enc = (t) => (codes && CODES[t]) || t;
  const dec = (h) => (codes && DECODE[h]) || h;

  function encode(n) {
    if (
      n.type === 'text' &&
      n.inline &&
      n.tag === undefined &&
      n.children.length === 0 &&
      !n.errors.length &&
      !n.annotations.length &&
      isEmpty(n.slots) &&
      !n.location
    ) {
      const keys = Object.keys(n.attributes);
      if (
        keys.length === 1 &&
        keys[0] === 'content' &&
        typeof n.attributes.content === 'string'
      )
        return n.attributes.content;
    }
    let head =
      n.type === 'tag' && n.tag !== undefined ? '%' + n.tag : enc(n.type);
    if (n.inline) head = '~' + head;
    const out = [head];
    let attrs = n.attributes;
    const extra = {};
    if (n.type !== 'tag' && n.tag !== undefined) extra.$t = n.tag;
    if (n.errors.length) extra.$e = n.errors;
    if (n.annotations.length) extra.$a = n.annotations;
    if (!isEmpty(n.slots))
      extra.$s = Object.fromEntries(
        Object.entries(n.slots).map(([k, v]) => [k, encode(v)])
      );
    if (n.location) extra.$l = n.location;
    if (!isEmpty(extra)) attrs = { ...attrs, ...extra };
    if (!isEmpty(attrs)) out.push(attrs);
    for (const c of n.children) out.push(encode(c));
    return out;
  }

  function decode(x) {
    if (typeof x === 'string') {
      const node = new Node('text', { content: x }, [], undefined);
      node.inline = true;
      return node;
    }
    let head = x[0];
    let inline = false;
    if (head.charCodeAt(0) === 126 /* ~ */) {
      inline = true;
      head = head.slice(1);
    }
    let type, tag;
    if (head.charCodeAt(0) === 37 /* % */) {
      type = 'tag';
      tag = head.slice(1);
    } else type = dec(head);

    let i = 1;
    let attrs = {};
    let extra;
    const second = x[1];
    if (x.length > 1 && typeof second === 'object' && !Array.isArray(second)) {
      i = 2;
      attrs = second;
      // "$"-keys are never attribute names (those are identifiers).
      for (const k in attrs)
        if (k.charCodeAt(0) === 36) {
          extra = attrs;
          break;
        }
      if (extra) {
        attrs = {};
        for (const k in extra) if (k.charCodeAt(0) !== 36) attrs[k] = extra[k];
      }
      attrs = reviveValue(attrs);
    }
    const children = new Array(x.length - i);
    for (let j = i; j < x.length; j++) children[j - i] = decode(x[j]);
    const node = new Node(type, attrs, children, extra?.$t ?? tag);
    if (inline) node.inline = true;
    if (extra) {
      if (extra.$e) node.errors = extra.$e;
      if (extra.$a) node.annotations = reviveValue(extra.$a);
      if (extra.$s)
        for (const k in extra.$s) node.slots[k] = decode(extra.$s[k]);
      if (extra.$l) node.location = extra.$l;
    }
    return node;
  }
  return { encode, decode };
}

// ---------------------------------------------------------------- formats
const packed = makePacked(false);
const packedCodes = makePacked(true);
const rootEnc = (enc) => (root) =>
  JSON.stringify(Array.isArray(root) ? { $list: root.map(enc) } : enc(root));
const rootDec = (dec) => (text) => {
  const v = JSON.parse(text);
  return v && v.$list ? v.$list.map(dec) : dec(v);
};

const FORMATS = {
  json: {
    encode: (root) => JSON.stringify(root),
    decode: (t) => M.Ast.fromJSON(t),
  },
  lean: { encode: rootEnc(leanEncode), decode: rootDec(leanDecode) },
  packed: { encode: rootEnc(packed.encode), decode: rootDec(packed.decode) },
  'packed+codes': {
    encode: rootEnc(packedCodes.encode),
    decode: rootDec(packedCodes.decode),
  },
};

const results = {};
for (const corpusName of ['pages', 'descriptions']) {
  const s = prepare(M, corpusName);
  // The stored tree: compact()ed, revived — exactly what runtime starts from.
  const roots = s.revived;
  const sourceBytes = s.sources.reduce((n, x) => n + Buffer.byteLength(x), 0);
  console.log(
    `\n${corpusName.toUpperCase()} — ${roots.length} docs, source ${fmtBytes(
      sourceBytes
    )}`
  );
  console.log(
    '  format'.padEnd(18) +
      'raw'.padStart(10) +
      'x src'.padStart(7) +
      'gzip'.padStart(10) +
      'brotli'.padStart(10)
  );

  const encoded = {};
  for (const [name, f] of Object.entries(FORMATS)) {
    encoded[name] = roots.map((r) => f.encode(r));
    // Exactness: decodes to the same Nodes (same JSON) and the same output.
    for (let i = 0; i < roots.length; i++) {
      const back = f.decode(encoded[name][i]);
      if (JSON.stringify(back) !== s.json[i])
        throw new Error(`${name}: mismatch on #${i}`);
      if (
        JSON.stringify(M.transform(back, s.config)) !==
        JSON.stringify(s.trees[i])
      )
        throw new Error(`${name}: transform mismatch on #${i}`);
    }
    const raw = encoded[name].reduce((n, x) => n + x.length, 0);
    // Compressed per document (what a per-page cache or HTTP response sees)
    // and as one blob.
    const gz = encoded[name].reduce((n, x) => n + zlib.gzipSync(x).length, 0);
    const br = encoded[name].reduce(
      (n, x) =>
        n +
        zlib.brotliCompressSync(x, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
        }).length,
      0
    );
    results[corpusName] ??= {};
    results[corpusName][name] = { raw, gz, br };
    console.log(
      `  ${name}`.padEnd(18) +
        fmtBytes(raw).padStart(10) +
        (raw / sourceBytes).toFixed(1).padStart(6) +
        'x' +
        fmtBytes(gz).padStart(10) +
        fmtBytes(br).padStart(10)
    );
  }

  report(
    `${corpusName.toUpperCase()} — decode (JSON.parse + revive to Nodes)`,
    compare(
      Object.fromEntries(
        Object.entries(FORMATS).map(([name, f]) => [
          name,
          () => {
            for (const t of encoded[name]) f.decode(t);
          },
        ])
      ),
      { rounds: 11, warmup: 3 }
    )
  );
  report(
    `${corpusName.toUpperCase()} — encode (Nodes to stored string)`,
    compare(
      Object.fromEntries(
        Object.entries(FORMATS).map(([name, f]) => [
          name,
          () => {
            for (const r of roots) f.encode(r);
          },
        ])
      ),
      { rounds: 7, warmup: 2 }
    )
  );
}

if (process.env.EXP_JSON)
  (await import('node:fs')).writeFileSync(
    process.env.EXP_JSON,
    JSON.stringify(results, null, 2)
  );
