import Ast from './src/ast';
import Node, { resolveNodeShared } from './src/ast/node';
import compact from './src/ast/compact';
import format, { formatScalar } from './src/formatter';
import functions from './src/functions';
import {
  parse as parseSource,
  parseFirstHeading,
  findFirstHeading,
} from './src/fastparse';
export type { FirstHeadingOptions } from './src/fastparse';
import * as nodes from './src/schema';
import renderers from './src/renderers';
import Tag from './src/tag';
import tags from './src/tags';
import { truthy } from './src/tags/conditional';
import transformer, { globalAttributes } from './src/transformer';
import transforms from './src/transforms';
import { isPromise, parseTags } from './src/utils';
import validator, { validateTree } from './src/validator';

import type { ParserArgs } from './src/types';
import type {
  Config,
  RenderableTreeNode,
  RenderableTreeNodes,
  ValidateError,
} from './src/types';

export * from './src/types';
export type { Packed, PackedNode, PackOptions } from './src/ast/pack';

// Brands a config returned by `prepareConfig`. A symbol key so it never shows
// up in `Object.keys` or JSON, and enumerable so it survives the
// `{ ...prepared, variables }` spread callers use to add per-call values.
const PREPARED = Symbol('markdoc.prepared');

type Prepared = Pick<Config, 'tags' | 'nodes' | 'functions'> & {
  cloneAst: boolean;
};

export type PrepareConfigOptions = {
  /**
   * `transform` normally copies the whole AST before transforming it, so
   * schema transforms work on a private copy with variables and functions
   * resolved. With `cloneAst: false`, only nodes holding (or containing) a
   * variable or function are copied; every other node is handed to schema
   * transforms as-is. Output is identical; the difference is only visible to
   * schema transforms that mutate the nodes they are given, whose changes
   * then land in the input AST. Use it when the AST is not reused, or when
   * no schema mutates nodes.
   */
  cloneAst?: boolean;
};

function mergeConfig(config: Config = {}): Config {
  // A prepared config already holds the merged schemas. It is reused only
  // while `tags`, `nodes` and `functions` are still the very objects that were
  // merged, so overriding one of them after preparing still merges as usual.
  const prepared = (config as { [PREPARED]?: Prepared })[PREPARED];
  if (
    prepared &&
    prepared.tags === config.tags &&
    prepared.nodes === config.nodes &&
    prepared.functions === config.functions
  )
    return { ...config };

  return {
    ...config,
    tags: {
      ...tags,
      ...config.tags,
    },
    nodes: {
      ...nodes,
      ...config.nodes,
    },
    functions: {
      ...functions,
      ...config.functions,
    },
  };
}

/**
 * Merges the built-in tags, nodes and functions into `config` once, so that
 * `transform` and `validate` can skip doing it on every call — which, with a
 * few dozen custom tags, is most of the cost of transforming a short document.
 *
 * The result is a snapshot: tags, nodes or functions added to the original
 * config (or to Markdoc's built-ins) afterwards are not seen. Spreading it to
 * add per-call values (`{ ...prepared, variables }`) keeps it prepared.
 */
export function prepareConfig<C extends Config = Config>(
  config?: C,
  { cloneAst = true }: PrepareConfigOptions = {}
): C {
  const merged = mergeConfig(config) as C & { [PREPARED]?: Prepared };
  merged[PREPARED] = {
    tags: merged.tags,
    nodes: merged.nodes,
    functions: merged.functions,
    cloneAst,
  };
  return merged;
}

export function parse(content: string, args?: string | ParserArgs): Node {
  return parseSource(content, args);
}

export function resolve<C extends Config = Config>(
  content: Node,
  config: C
): Node;
export function resolve<C extends Config = Config>(
  content: Node[],
  config: C
): Node[];
export function resolve<C extends Config = Config>(
  content: any,
  config: C
): any {
  if (Array.isArray(content))
    return content.flatMap((child) => child.resolve(config));

  return content.resolve(config);
}

export function transform<C extends Config = Config>(
  node: Node,
  config?: C
): RenderableTreeNodes;
export function transform<C extends Config = Config>(
  nodes: Node[],
  config?: C
): RenderableTreeNode[];
export function transform<C extends Config = Config>(
  nodes: any,
  options?: C
): any {
  const config = mergeConfig(options);
  const prepared = (options as { [PREPARED]?: Prepared } | undefined)?.[
    PREPARED
  ];
  const content: any =
    prepared && !prepared.cloneAst
      ? Array.isArray(nodes)
        ? nodes.flatMap((child) => resolveNodeShared(child, config))
        : resolveNodeShared(nodes, config)
      : resolve(nodes, config);

  if (Array.isArray(content))
    return content.flatMap((child) => child.transform(config));
  return content.transform(config);
}

export function validate<C extends Config = Config>(
  node: Node,
  options?: C
): ValidateError[];
export function validate<C extends Config = Config>(
  content: any,
  options?: C
): any {
  const config = mergeConfig(options);
  return validateTree(content, config);
}

/**
 * Parses `source` and validates the result: the same AST as `parse(source,
 * args)` and the same errors as `validate(ast, config)`, from one call.
 * Parse with locations (the default) when the errors should point at lines;
 * `Ast.pack(ast, { compact: true })` drops them when storing the AST.
 *
 * When a validator is asynchronous, the result is a promise of that object,
 * just as `validate` then returns a promise (which its type also leaves out).
 */
export function parseAndValidate<C extends Config = Config>(
  source: string,
  config?: C,
  args?: string | ParserArgs
): { ast: Node; errors: ValidateError[] } {
  const ast = parse(source, args);
  const errors: ValidateError[] | Promise<ValidateError[]> = validate(
    ast,
    config
  );
  if (isPromise(errors))
    return errors.then((errors) => ({ ast, errors })) as any;
  return { ast, errors };
}

export function createElement(
  name: string | { key?: string | number },
  attributes = {},
  ...children: any[]
) {
  return { name, attributes, children };
}

export {
  nodes,
  tags,
  functions,
  globalAttributes,
  transforms,
  renderers,
  Ast,
  Node,
  Tag,
  parseTags,
  transformer,
  validator,
  truthy,
  format,
  formatScalar,
  compact,
  parseFirstHeading,
  findFirstHeading,
};

export default class Markdoc {
  static nodes = nodes;
  static tags = tags;
  static functions = functions;
  static globalAttributes = globalAttributes;
  static renderers = renderers;
  static transforms = transforms;
  static Ast = Ast;
  static Tag = Tag;
  static parseTags = parseTags;
  static transformer = transformer;
  static validator = validator;
  static parse = parse;
  static prepareConfig = prepareConfig;
  static transform = transform;
  static validate = validate;
  static parseAndValidate = parseAndValidate;
  static parseFirstHeading = parseFirstHeading;
  static findFirstHeading = findFirstHeading;
  static createElement = createElement;
  static truthy = truthy;
  static format = format;
  static formatScalar = formatScalar;
  static compact = compact;

  config;
  constructor(config: Config) {
    this.config = config;
  }

  parse = parse;
  resolve = (content: Parameters<typeof resolve>[0]) =>
    resolve(content, this.config);
  transform = (content: Parameters<typeof transform>[0]) =>
    transform(content, this.config);
  validate = (content: Parameters<typeof validate>[0]) =>
    validate(content, this.config);
  parseAndValidate = (source: string, args?: string | ParserArgs) =>
    parseAndValidate(source, this.config, args);
}
