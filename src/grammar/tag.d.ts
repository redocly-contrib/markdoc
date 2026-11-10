import type AstVariable from '../ast/variable';
import type AstFunction from '../ast/function';
import type { Value } from '../types';

type astTypes = {
  Variable?: typeof AstVariable;
  Function?: typeof AstFunction;
};

export function parse(
  input: string,
  options?: astTypes & { startRule?: 'Top' }
): { type: string; meta?: any; nesting?: number };
export function parse(
  input: string,
  options: astTypes & { startRule: 'Value' }
): Value;

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
