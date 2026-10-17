import type Node from '../ast/node';
import type { AttributeValue } from '../types';

/** Applies a tag's (or annotation's) attributes to a node, as Markdoc does. */
export function annotate(node: Node, attributes: AttributeValue[]) {
  for (const attribute of attributes) {
    node.addAnnotation(attribute);

    const { name, value, type } = attribute;
    if (type === 'attribute') {
      if (node.attributes[name] !== undefined)
        node.addError({
          id: 'duplicate-attribute',
          level: 'warning',
          message: `Attribute '${name}' already set`,
        });
      node.attributes[name] = value;
    } else if (type === 'class')
      if (node.attributes.class) node.attributes.class[name] = value;
      else node.attributes.class = { [name]: value };
  }
}
