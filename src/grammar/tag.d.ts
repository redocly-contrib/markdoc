import type AstVariable from '../ast/variable';
import type AstFunction from '../ast/function';

type astTypes = {
  Variable?: typeof AstVariable;
  Function?: typeof AstFunction;
};

export function parse(
  input: string,
  astTypes?: astTypes
): { type: string; meta?: any; nesting?: number };

type PegLocation = {
  offset: number;
  line: number;
  column: number;
};

export interface SyntaxError extends Error {
  location: {
    start: PegLocation;
    end: PegLocation;
  };
}
