import Ast from './src/ast';
import Node, { resolveNodeShared } from './src/ast/node';
import compact from './src/ast/compact';
import format from './src/formatter';
import functions from './src/functions';
import parser from './src/parser';
import { fastParse } from './src/fastparse';
import * as nodes from './src/schema';
import renderers from './src/renderers';
import Tag from './src/tag';
import tags from './src/tags';
import { truthy } from './src/tags/conditional';
import Tokenizer from './src/tokenizer';
import transformer, { globalAttributes } from './src/transformer';
import transforms from './src/transforms';
import { parseTags } from './src/utils';
import validator, { validateTree } from './src/validator';

import type { ParserArgs } from './src/types';
import type Token from 'markdown-it/lib/token';
import type {
  Config,
  RenderableTreeNode,
  RenderableTreeNodes,
  ValidateError,
} from './src/types';

export * from './src/types';
export type { Packed, PackedNode } from './src/ast/pack';

const tokenizer = new Tokenizer();
// Alternate tokenizer for callers that pass `githubAdmonitions: false` to
// `parse()`. Lazily constructed because most callers want the default behavior.
let plainTokenizer: Tokenizer | undefined;

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

export function parse(
  content: string | Token[],
  args?: string | ParserArgs
): Node {
  if (typeof content === 'string') {
    const opts = typeof args === 'object' ? args : undefined;
    if (opts?.githubAdmonitions === false) {
      plainTokenizer ??= new Tokenizer({ githubAdmonitions: false });
      content = plainTokenizer.tokenize(content);
    } else {
      content = tokenizer.tokenize(content);
    }
  }
  const doc = parser(content, args);

  const opts = typeof args === 'object' ? args : undefined;
  if (
    opts?.compact &&
    doc.type === 'document' &&
    doc.children.length === 1 &&
    !Object.keys(doc.slots ?? {}).length &&
    !doc.errors?.length &&
    !doc.children[0].errors?.length &&
    !doc.attributes.frontmatter
  ) {
    return doc.children[0];
  }

  return doc;
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
  Tokenizer,
  parseTags,
  transformer,
  validator,
  truthy,
  format,
  compact,
  fastParse,
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
  static Tokenizer = Tokenizer;
  static parseTags = parseTags;
  static transformer = transformer;
  static validator = validator;
  static parse = parse;
  static prepareConfig = prepareConfig;
  static transform = transform;
  static validate = validate;
  static createElement = createElement;
  static truthy = truthy;
  static format = format;
  static compact = compact;
  static fastParse = fastParse;

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
}
