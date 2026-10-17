import Node from './node';
import Function from './function';
import Variable from './variable';
import * as base from './base';
import compact from './compact';
import { pack, unpack } from './pack';

const AstTypes = {
  Function,
  Node,
  Variable,
};

/**
 * Turns plain parsed JSON back into AST class instances, bottom-up, in place.
 *
 * Equivalent to `JSON.parse(text, reviver)` with a reviver that does
 * `Object.assign(new klass(), value)` for every `$$mdtype` object — but a
 * reviver makes V8 call back into JS for every value in the document (each
 * string and number too) and gives up its JSON fast path, which made reviving
 * ~2x slower than parsing plus this walk.
 */
function revive(value: any): any {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item !== null && typeof item === 'object') {
        const revived = revive(item);
        if (revived !== item) value[i] = revived;
      }
    }
    return value;
  }

  for (const key in value) {
    const item = value[key];
    if (item !== null && typeof item === 'object') {
      // Only write back when the value was replaced, so a stray `__proto__`
      // key in stored JSON is never routed through the prototype setter.
      const revived = revive(item);
      if (revived !== item)
        Object.defineProperty(value, key, {
          value: revived,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
  }

  const klass = AstTypes[value.$$mdtype as keyof typeof AstTypes] as any;
  return klass ? Object.assign(new klass(), value) : value;
}

function fromJSON(text: string): Node | Node[] {
  const value = JSON.parse(text);
  return value !== null && typeof value === 'object' ? revive(value) : value;
}

export default {
  ...AstTypes,
  ...base,
  fromJSON,
  compact,
  pack,
  unpack,
};
