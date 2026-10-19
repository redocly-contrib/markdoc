import { globalAttributes, typeInstance } from './transformer';
import Ast from './ast/index';
import { isPromise } from './utils';

import type {
  Location,
  Node,
  Function,
  Config,
  SchemaAttribute,
  ValidateError,
  ValidationError,
  Value,
} from './types';

const TypeMappings = {
  String: String,
  Number: Number,
  Array: Array,
  Object: Object,
  Boolean: Boolean,
} as const;

type TypeParam = NonNullable<SchemaAttribute['type']>;

/**
 * The config that one node's validators see during `validateTree`: a copy of
 * the config with the node's own `validation.parents`, as each node got from
 * `walkWithParents`, so a validator that changes it cannot affect another
 * node. It is built the first time a validator of the node needs it; most
 * nodes (text, inline, paragraphs) have none and never pay for the copy.
 */
class NodeConfig {
  private own: Config | undefined;
  private parents: Node[] = [];

  constructor(private readonly base: Config) {}

  /** Moves on to a node with these ancestors (shared, never handed out). */
  next(parents: Node[]) {
    this.parents = parents;
    this.own = undefined;
  }

  get(): Config {
    return (this.own ??= {
      ...this.base,
      validation: { ...this.base.validation, parents: this.parents.slice() },
    });
  }
}

/** What user code is given: the node's own config in `validateTree`. */
function userConfig(config: Config, scope: NodeConfig | undefined): Config {
  return scope ? scope.get() : config;
}

export function validateType(
  type: TypeParam,
  value: Value,
  config: Config,
  key: string,
  scope?: NodeConfig
): boolean | ValidationError[] {
  if (!type) return true;

  if (Ast.isFunction(value) && config.validation?.validateFunctions) {
    const schema = config.functions?.[value.name];
    return !schema?.returns
      ? true
      : Array.isArray(schema.returns)
      ? schema.returns.find((t) => t === type) !== undefined
      : schema.returns === type;
  }

  if (Ast.isAst(value)) return true;

  if (Array.isArray(type))
    return type.some((t) => validateType(t, value, config, key, scope));

  if (typeof type === 'string') type = TypeMappings[type];

  if (typeof type === 'function') {
    const instance = typeInstance(type);
    if (instance.validate) {
      return instance.validate(value, userConfig(config, scope), key);
    }
  }

  return value != null && value.constructor === type;
}

function typeToString(type: TypeParam): string {
  if (typeof type === 'string') return type;

  if (Array.isArray(type)) return type.map(typeToString).join(' | ');

  return type.name;
}

function validateFunction(
  fn: Function,
  config: Config,
  scope: NodeConfig | undefined
): ValidationError[] {
  const schema = config.functions?.[fn.name];
  const errors: ValidationError[] = [];

  if (!schema)
    return [
      {
        id: 'function-undefined',
        level: 'critical',
        message: `Undefined function: '${fn.name}'`,
      },
    ];

  if (schema.validate)
    errors.push(...schema.validate(fn, userConfig(config, scope)));

  if (schema.parameters) {
    for (const [key, value] of Object.entries(fn.parameters)) {
      const param = schema.parameters?.[key];

      if (!param) {
        errors.push({
          id: 'parameter-undefined',
          level: 'error',
          message: `Invalid parameter: '${key}'`,
        });

        continue;
      }

      if (Ast.isAst(value) && !Ast.isFunction(value)) continue;

      if (param.type) {
        const valid = validateType(param.type, value, config, key, scope);
        if (valid === false) {
          errors.push({
            id: 'parameter-type-invalid',
            level: 'error',
            message: `Parameter '${key}' of '${
              fn.name
            }' must be type of '${typeToString(param.type)}'`,
          });
        } else if (Array.isArray(valid)) {
          errors.push(...valid);
        }
      }
    }
  }

  for (const [key, { required }] of Object.entries(schema.parameters ?? {}))
    if (required && fn.parameters[key] === undefined)
      errors.push({
        id: 'parameter-missing-required',
        level: 'error',
        message: `Missing required parameter: '${key}'`,
      });

  return errors;
}

function displayMatches(matches: any[], n: number) {
  if (matches.length <= n) return JSON.stringify(matches);
  const items = matches.slice(0, n).map((item) => JSON.stringify(item));
  return `[${items.join(',')}, ... ${matches.length - n} more]`;
}

export default function validator(node: Node, config: Config) {
  return validateNode(node, config, undefined);
}

function validateNode(
  node: Node,
  config: Config,
  scope: NodeConfig | undefined
) {
  const schema = node.findSchema(config);
  const errors: ValidationError[] = [...(node.errors || [])];

  if (!schema) {
    errors.push({
      id: node.tag ? 'tag-undefined' : 'node-undefined',
      level: 'critical',
      message: node.tag
        ? `Undefined tag: '${node.tag}'`
        : `Undefined node: '${node.type}'`,
    });

    return errors;
  }

  if (schema.inline != undefined && node.inline !== schema.inline)
    errors.push({
      id: 'tag-placement-invalid',
      level: 'critical',
      message: `'${node.tag}' tag should be ${
        schema.inline ? 'inline' : 'block'
      }`,
    });

  if (schema.selfClosing && node.children.length > 0)
    errors.push({
      id: 'tag-selfclosing-has-children',
      level: 'critical',
      message: `'${node.tag}' tag should be self-closing`,
    });

  // Looked up as `{ ...globalAttributes, ...schema.attributes }[key]` would
  // answer, without building that merged object for every node.
  const schemaAttributes = schema.attributes;

  if (node.slots && hasOwnKeys(node.slots))
    for (const key of Object.keys(node.slots)) {
      const slot = schema.slots?.[key];
      if (!slot)
        errors.push({
          id: 'slot-undefined',
          level: 'error',
          message: `Invalid slot: '${key}'`,
        });
    }

  for (const key of Object.keys(node.attributes)) {
    let value = node.attributes[key];
    const attrib =
      schemaAttributes &&
      Object.prototype.hasOwnProperty.call(schemaAttributes, key)
        ? schemaAttributes[key]
        : (globalAttributes as Record<string, any>)[key];

    if (!attrib) {
      errors.push({
        id: 'attribute-undefined',
        level: 'error',
        message: `Invalid attribute: '${key}'`,
      });

      continue;
    }

    let { type, matches, errorLevel } = attrib;

    if (Ast.isAst(value)) {
      if (Ast.isFunction(value) && config.validation?.validateFunctions)
        errors.push(...validateFunction(value, config, scope));
      else if (Ast.isVariable(value) && config.variables) {
        let missing = false;
        let variables = config.variables;

        for (const key of value.path) {
          if (!Object.prototype.hasOwnProperty.call(variables, key)) {
            missing = true;
            break;
          }
          variables = variables[key];
        }

        if (missing) {
          errors.push({
            id: 'variable-undefined',
            level: 'error',
            message: `Undefined variable: '${value.path.join('.')}'`,
          });
        }
      } else continue;
    }

    value = value as string;

    if (type) {
      const valid = validateType(type, value, config, key, scope);
      if (valid === false) {
        errors.push({
          id: 'attribute-type-invalid',
          level: errorLevel || 'error',
          message: `Attribute '${key}' must be type of '${typeToString(type)}'`,
        });
      }
      if (Array.isArray(valid)) {
        errors.push(...valid);
      }
    }

    if (typeof matches === 'function')
      matches = matches(userConfig(config, scope));

    if (Array.isArray(matches) && !matches.includes(value))
      errors.push({
        id: 'attribute-value-invalid',
        level: errorLevel || 'error',
        message: `Attribute '${key}' must match one of ${displayMatches(
          matches,
          8
        )}. Got '${value}' instead.`,
      });

    if (matches instanceof RegExp && !matches.test(value))
      errors.push({
        id: 'attribute-value-invalid',
        level: errorLevel || 'error',
        message: `Attribute '${key}' must match ${matches}. Got '${value}' instead.`,
      });

    if (typeof attrib.validate === 'function') {
      const attribErrors = attrib.validate(
        value,
        userConfig(config, scope),
        key
      );
      if (Array.isArray(attribErrors)) errors.push(...attribErrors);
    }
  }

  // `{ ...globalAttributes, ...schema.attributes }` in that object's order.
  for (const key of Object.keys(globalAttributes!))
    checkRequired(
      errors,
      node,
      key,
      schemaAttributes &&
        Object.prototype.hasOwnProperty.call(schemaAttributes, key)
        ? schemaAttributes[key]
        : (globalAttributes as Record<string, any>)[key]
    );
  if (schemaAttributes)
    for (const key of Object.keys(schemaAttributes))
      if (!Object.prototype.hasOwnProperty.call(globalAttributes, key))
        checkRequired(errors, node, key, schemaAttributes[key]);

  if (schema.slots)
    for (const [key, { required }] of Object.entries(schema.slots))
      if (required && node.slots?.[key] === undefined)
        errors.push({
          id: 'slot-missing-required',
          level: 'error',
          message: `Missing required slot: '${key}'`,
        });

  for (const { type } of node.children) {
    if (schema.children && type !== 'error' && !schema.children.includes(type))
      errors.push({
        id: 'child-invalid',
        level: 'warning',
        message: `Can't nest '${type}' in '${node.tag || node.type}'`,
      });
  }

  if (schema.validate) {
    const schemaErrors = schema.validate(node, userConfig(config, scope));
    if (isPromise(schemaErrors)) {
      return schemaErrors.then((e) => errors.concat(e));
    }

    errors.push(...schemaErrors);
  }

  return errors;
}

function hasValidLocation(
  error: ValidationError
): error is ValidationError & { location: Location } {
  const loc = error.location;
  return (
    loc != null &&
    typeof loc.start?.line === 'number' &&
    typeof loc.end?.line === 'number' &&
    (loc.file === undefined || typeof loc.file === 'string')
  );
}

function toValidateError(
  node: { type: string; location?: Location },
  error: ValidationError
): ValidateError {
  if (hasValidLocation(error)) {
    return {
      type: node.type,
      lines: [error.location.start.line, error.location.end.line],
      location: { file: node.location?.file, ...error.location },
      error,
    };
  }
  // `lines` is kept on the public error shape for compatibility, but it is
  // now purely derived from `location` rather than stored per Node.
  const loc = node.location;
  return {
    type: node.type,
    lines: loc ? [loc.start.line, loc.end.line] : [],
    location: loc,
    error,
  };
}

function hasOwnKeys(object: object): boolean {
  for (const key in object)
    if (Object.prototype.hasOwnProperty.call(object, key)) return true;
  return false;
}

function checkRequired(
  errors: ValidationError[],
  node: Node,
  key: string,
  attribute: SchemaAttribute
) {
  if (attribute.required && node.attributes[key] === undefined)
    errors.push({
      id: 'attribute-missing-required',
      level: 'error',
      message: `Missing required attribute: '${key}'`,
    });
}

/**
 * Every node with its ancestors, in document order (a node, its slots, then
 * its children), as two parallel arrays. Siblings share one ancestors array;
 * `NodeConfig` copies it for any validator that sees it.
 */
function collectForValidation(
  node: Node,
  parents: Node[],
  nodes: Node[],
  ancestors: Node[][]
) {
  nodes.push(node);
  ancestors.push(parents);

  const slots = node.slots;
  const hasSlots = !!slots && hasOwnKeys(slots);
  if (!hasSlots && node.children.length === 0) return;

  const childParents = [...parents, node];
  if (hasSlots)
    for (const child of Object.values(slots))
      collectForValidation(child, childParents, nodes, ancestors);
  for (const child of node.children)
    collectForValidation(child, childParents, nodes, ancestors);
}

export function validateTree(content: Node, config: Config) {
  const nodes: Node[] = [];
  const ancestors: Node[][] = [];
  collectForValidation(content, [], nodes, ancestors);

  // Every validator runs first, in order, as before; the results are then
  // flattened into one list (or one promise, if any validator is async).
  const results: (ValidationError[] | Promise<ValidationError[]>)[] = new Array(
    nodes.length
  );
  const scope = new NodeConfig(config);
  let async = false;
  for (let i = 0; i < nodes.length; i++) {
    scope.next(ancestors[i]);
    const errors = validateNode(nodes[i], config, scope);
    if (isPromise(errors)) async = true;
    results[i] = errors;
  }

  if (async) {
    return Promise.all(
      results.map((errors, i) =>
        isPromise(errors)
          ? errors.then((e) =>
              e.map((error) => toValidateError(nodes[i], error))
            )
          : errors.map((error) => toValidateError(nodes[i], error))
      )
    ).then((o) => o.flat());
  }

  const output: ValidateError[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const errors = results[i] as ValidationError[];
    for (let j = 0; j < errors.length; j++)
      output.push(toValidateError(nodes[i], errors[j]));
  }
  return output;
}
