import Ast from '../ast/index';

import type { Node, NodeType, ValidationError, ParserArgs } from '../types';

function convertToRow(node: Node, cellType: NodeType = 'td') {
  node.type = 'tr';
  node.attributes = {};

  for (const cell of node.children) cell.type = cellType;

  return node;
}

function isConditionalTag(node: Node, conditionalTags: string[]) {
  return (
    node.type === 'tag' && !!node.tag && conditionalTags.includes(node.tag)
  );
}

function isComment(node: Node) {
  return (
    node.type === 'comment' || (node.type === 'tag' && node.tag === 'comment')
  );
}

function unexpectedNodeError(node: Node): ValidationError {
  return {
    id: 'table-syntax',
    level: 'critical',
    message: `Found ${node.type}${
      node.tag ? ` ${node.tag}` : ''
    } where a list was expected. Make sure all content inside table cells is indented.`,
    location: node.location,
  };
}

export default function transform(
  document: Node,
  args?: ParserArgs
) {
  const conditionalTags = args?.conditionalTags ?? ['if'];
  // Reporting malformed table content is opt-in. Upstream reports it by
  // default, but content that predates the check still renders the same way
  // (the offending node was always dropped), so defaulting to on would turn
  // previously-building content into a build failure. The node is dropped
  // either way — only the diagnostic is gated.
  const strictTables = args?.strictTables ?? false;
  const report = (target: Node, offender: Node) => {
    if (strictTables) target.addError(unexpectedNodeError(offender));
  };

  for (const node of document.walk()) {
    if (node.type !== 'tag' || node.tag !== 'table') continue;

    const [first, ...rest] = node.children;
    if (!first || first.type === 'table') continue;

    const table = new Ast.Node('table', node.attributes, [
      new Ast.Node('thead'),
      new Ast.Node('tbody'),
    ]);

    const [thead, tbody] = table.children;

    if (first.type === 'list') thead.push(convertToRow(first, 'th'));
    // A header row must be a list. Anything else (other than a separator or a
    // comment) is dropped, and reported when `strictTables` is set.
    else if (first.type !== 'hr' && !isComment(first)) report(node, first);

    for (const row of rest) {
      // Convert lists to rows with special-case support for conditionals
      // When a conditional is encountered, convert all of its top-level lists to rows
      if (row.type === 'list') convertToRow(row);
      else if (isConditionalTag(row, conditionalTags)) {
        const children = [];

        for (const child of row.children) {
          // Replace children and skip HRs in order to support conditionals with multiple rows
          if (child.type === 'hr') continue;
          if (child.type === 'list') convertToRow(child);
          else if (
            isComment(child) ||
            child.tag === 'else' ||
            isConditionalTag(child, conditionalTags)
          ) {
            // Allow structural tags: else, nested conditionals, and comments
          } else {
            report(row, child);
            continue;
          }
          children.push(child);
        }

        row.children = children;
      } else if (row.type !== 'hr' && !isComment(row)) {
        report(node, row);
        continue;
      } else continue;
      tbody.push(row);
    }

    node.children = [table];
  }
}
