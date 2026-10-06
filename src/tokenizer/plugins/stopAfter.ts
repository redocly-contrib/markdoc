import type StateBlock from 'markdown-it/lib/rules_block/state_block';
import type Token from 'markdown-it/lib/token';

export type StopAfterPredicate = (token: Token) => boolean;

export type StopAfterEnv = {
  stopAfter?: StopAfterPredicate;
  checked?: number;
  stopped?: boolean;
};

/**
 * Block rule that aborts tokenization once a caller-supplied predicate matches
 * a token that has already been emitted.
 *
 * This is sound because the block tokenizer only ever appends: it reads the
 * source top to bottom and never revisits tokens it has produced. Markdoc has
 * no setext/underline headings, so a later line can never retroactively turn an
 * earlier line into something else. That means "stop after the first token
 * matching P" yields exactly the prefix a full parse would have produced.
 *
 * Must be registered before every other block rule so the check runs at the top
 * of each iteration of the tokenizer loop, including the nested loops that
 * blockquotes and list items run.
 */
export default function stopAfterRule(
  state: StateBlock,
  _startLine: number,
  endLine: number
): boolean {
  const env = state.env as StopAfterEnv;
  if (!env.stopAfter) return false;

  // Scan only the tokens appended since the last check.
  for (let i = env.checked ?? 0; i < state.tokens.length; i++) {
    if (env.stopAfter(state.tokens[i])) env.stopped = true;
  }
  env.checked = state.tokens.length;

  if (!env.stopped) return false;

  // Jumping to the end terminates this tokenizer loop. Outer loops (blockquote,
  // list item) resume and immediately hit this rule again, so they stop too.
  state.line = endLine;
  return true;
}
