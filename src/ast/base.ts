import type {
  AstType,
  Config,
  Function as AstFunction,
  Scalar,
  Variable as AstVariable,
} from '../types';

export function isAst(value?: any): value is AstType {
  return !!value?.$$mdtype;
}

export function isFunction(value?: any): value is AstFunction {
  return !!(value?.$$mdtype === 'Function');
}

export function isVariable(value?: any): value is AstVariable {
  return !!(value?.$$mdtype === 'Variable');
}

export function* getAstValues(value: any): Generator<AstType, void, unknown> {
  if (value == null || typeof value !== 'object') return;

  if (Array.isArray(value)) for (const v of value) yield* getAstValues(v);

  if (isAst(value)) yield value;

  if (Object.getPrototypeOf(value) !== Object.prototype) return;

  for (const v of Object.values(value)) yield* getAstValues(v);
}

export function resolve(value: any, config: Config = {}): any {
  if (value == null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => resolve(item, config));

  if (isAst(value) && value?.resolve instanceof Function)
    return value.resolve(config);

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const output: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(value)) output[k] = resolve(v, config);
  return output;
}

/**
 * Like `resolve`, but returns `value` itself whenever nothing inside it
 * resolves to something new, copying only the containers on the way to a
 * variable or function. AST values are resolved through `resolveNode` (for
 * Nodes) or their own `resolve`.
 */
export function resolveShared(
  value: any,
  config: Config,
  resolveNode: (node: any, config: Config) => any
): any {
  if (value == null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let output: any[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item = resolveShared(value[i], config, resolveNode);
      if (item !== value[i]) (output ??= value.slice())[i] = item;
    }
    return output ?? value;
  }

  if (isAst(value) && value?.resolve instanceof Function)
    return value.$$mdtype === 'Node'
      ? resolveNode(value, config)
      : value.resolve(config);

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  let output: Record<string, Scalar> | undefined;
  for (const k of Object.keys(value)) {
    const item = resolveShared(value[k], config, resolveNode);
    if (item !== value[k]) (output ??= { ...value })[k] = item;
  }
  return output ?? value;
}
