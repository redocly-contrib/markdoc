import type Func from './ast/function';
import type Node from './ast/node';
import type Var from './ast/variable';
import type Tag from './tag';

export type { Node, Tag };
export declare type Function = Func;
export declare type Variable = Var;

export type MaybePromise<T> = T | Promise<T>;

export interface AstType {
  readonly $$mdtype: 'Function' | 'Node' | 'Variable';
  resolve(config: Config): any;
}

export type AttributeValue = {
  type: string;
  name: string;
  value: any;
};

export type Config<R = string> = Readonly<ConfigType<R>>;

export type ConfigType<R = string> = Partial<{
  nodes: Partial<Record<NodeType, Schema<ConfigType, R>>>;
  tags: Record<string, Schema>;
  variables: Record<string, any>;
  functions: Record<string, ConfigFunction>;
  partials: Record<string, any>;
  validation?: {
    parents?: Node[];
    validateFunctions?: boolean;
    environment?: string;
  };
  // When true, the transformer elides `<article>` around a single-child
  // `document` and `<p>` around a single block-level tag, producing a
  // more compact renderable tree.
  // @default false
  compact?: boolean;
}>;

export type ConfigFunction = {
  returns?: ValidationType | ValidationType[];
  parameters?: Record<string, SchemaAttribute>;
  transform?(parameters: Record<string, any>, config: Config): any;
  validate?(fn: Func, config: Config): ValidationError[];
};

export interface CustomAttributeTypeInterface {
  transform?(value: any, config: Config): Scalar;
  validate?(value: any, config: Config, name: string): ValidationError[];
}

export interface CustomAttributeType {
  new (): CustomAttributeTypeInterface;
  readonly prototype: CustomAttributeTypeInterface;
}

export type Location = {
  file?: string;
  start: LocationEdge;
  end: LocationEdge;
};

export type LocationEdge = {
  line: number;
  character?: number;
};

export type NodeType =
  | 'blockquote'
  | 'code'
  | 'comment'
  | 'document'
  | 'em'
  | 'error'
  | 'fence'
  | 'hardbreak'
  | 'heading'
  | 'hr'
  | 'image'
  | 'inline'
  | 'item'
  | 'link'
  | 'list'
  | 'node'
  | 'paragraph'
  | 's'
  | 'softbreak'
  | 'strong'
  | 'table'
  | 'tag'
  | 'tbody'
  | 'td'
  | 'text'
  | 'th'
  | 'thead'
  | 'tr';

export type Primitive = null | boolean | number | string;

export type RenderableTreeNode = Tag | Scalar;
export type RenderableTreeNodes = RenderableTreeNode | RenderableTreeNode[];

export type Scalar = Primitive | Scalar[] | { [key: string]: Scalar };

/**
 * A node type that may appear as a child. `NodeType` covers the built-ins and
 * drives autocomplete, but node types are derived from token types at runtime
 * and consumers add their own (e.g. `html_block`, `html_inline` from custom
 * HTML token processing), so any string is accepted.
 */
export type SchemaChild = NodeType | (string & {});

export type Schema<C extends Config = Config, R = string> = {
  render?: R;
  children?: SchemaChild[];
  attributes?: Record<string, SchemaAttribute>;
  slots?: Record<string, SchemaSlot>;
  selfClosing?: boolean;
  inline?: boolean;
  transform?(node: Node, config: C): MaybePromise<RenderableTreeNodes>;
  validate?(node: Node, config: C): MaybePromise<ValidationError[]>;
  description?: string;
};

export type SchemaAttribute = {
  type?: ValidationType | ValidationType[];
  render?: boolean | string;
  default?: any;
  required?: boolean;
  matches?: SchemaMatches | ((config: Config) => SchemaMatches);
  validate?(value: any, config: Config, name: string): ValidationError[];
  errorLevel?: ValidationError['level'];
  description?: string;
};

export type SchemaMatches = RegExp | string[] | null;

export type SchemaSlot = {
  render?: boolean | string;
  required?: boolean;
};

export interface Transformer {
  findSchema(node: Node, config: Config): Schema | undefined;
  node(node: Node, config: Config): MaybePromise<RenderableTreeNodes>;
  attributes(node: Node, config: Config): Record<string, any>;
  children(node: Node, config: Config): RenderableTreeNode[];
}

export type ValidationError = {
  id: string;
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  message: string;
  location?: Location;
};

export type ValidateError = {
  type: string;
  lines: number[];
  location?: Location;
  error: ValidationError;
};

export type ValidationType =
  | CustomAttributeType
  | typeof String
  | typeof Number
  | typeof Boolean
  | typeof Object
  | typeof Array
  | 'String'
  | 'Number'
  | 'Boolean'
  | 'Object'
  | 'Array';

export type Value = AstType | Scalar;

export type ParserArgs = {
  file?: string;
  slots?: boolean;
  location?: boolean;
  // A list of tags that are allowed to wrap table body content.
  // During table transformation, these tags are kept as wrappers in tbody.
  // Tags not in this list that appear between table rows are dropped, which prevents arbitrary custom components from wrapping rows in ways that could produce invalid HTML.
  // @default ['if'] - By default, only the markdoc native conditional tag (`if`) is set
  conditionalTags?: string[];
  // When true, the parser produces a compact AST:
  //  - no `lines` or `location` is set on any Node
  //  - the implicit `inline` wrapper Node around inline content is dropped
  //  - the top-level `document` Node is dropped when it has a single child,
  //    no slots, no errors, and no frontmatter
  // @default false
  compact?: boolean;
  // When true, a markdoc tag that appears alone in an implicit paragraph
  // (e.g. `{% tag %}content{% /tag %}` on its own line) is lifted out of
  // the paragraph so it becomes a direct child of its surrounding container.
  // @default false
  noParagraphForLoneTag?: boolean;
  // GitHub-style admonitions (`> [!NOTE]\n> body`) are recognized by the
  // default tokenizer used when `parse()` is given a string. Pass `false`
  // here to opt out — the convenience `parse(string)` path will use an
  // alternate tokenizer without the plugin. Ignored when `content` is
  // already a Token[] (you control the tokenizer in that case).
  // @default true
  githubAdmonitions?: boolean;
};
