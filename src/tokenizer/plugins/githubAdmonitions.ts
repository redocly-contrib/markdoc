import type MarkdownIt from 'markdown-it/lib';
import type StateCore from 'markdown-it/lib/rules_core/state_core';

const KINDS = new Set([
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'info',
  'success',
  'danger',
]);

const MARKER_RE = /^\[!([A-Za-z]+)]\s*(?:\n|$)/;

function core(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 3; i++) {
    if (
      tokens[i].type !== 'blockquote_open' ||
      tokens[i + 1].type !== 'paragraph_open' ||
      tokens[i + 2].type !== 'inline' ||
      tokens[i + 3].type !== 'paragraph_close'
    ) {
      continue;
    }

    const inlineContent = tokens[i + 2].content;
    const match = MARKER_RE.exec(inlineContent);
    if (!match) continue;

    const kind = match[1].toLowerCase();
    if (!KINDS.has(kind)) continue;

    const open = tokens[i];
    open.attrs = open.attrs ? [...open.attrs, ['kind', kind]] : [['kind', kind]];

    // Strip the marker line from the inline content, keeping the body.
    const bodyContent = inlineContent.slice(match[0].length);
    const inlineToken = tokens[i + 2];
    if (bodyContent.length === 0) {
      // Only the marker, no body — remove the marker paragraph entirely.
      tokens.splice(i + 1, 3);
    } else {
      // Replace inline content with the body text after the marker.
      inlineToken.content = bodyContent;
      // Also drop the marker children from inline.children,
      // because the Node parser walks children, not content.
      if (inlineToken.children) {
        const breakIdx = inlineToken.children.findIndex(
          (c) => c.type === 'softbreak' || c.type === 'hardbreak'
        );
        if (breakIdx !== -1) {
          inlineToken.children = inlineToken.children.slice(breakIdx + 1);
        }
      }
    }
  }
}

export default function plugin(md: MarkdownIt) {
  md.core.ruler.push('githubAdmonitions', core);
}
