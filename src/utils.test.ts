import { findTagEnd, parseAttributeValue, parseTags } from '../src/utils';
import Variable from '../src/ast/variable';
import Function from '../src/ast/function';

describe('Templating', function () {
  describe('parseTags', function () {
    it('simple example', function () {
      const example =
        'this is a {% foo blah="asdf" %}test{% /foo %} of template parsing';
      const output = parseTags(example);
      const expected = [
        { type: 'text', content: 'this is a ', start: 0, end: 9 },
        {
          type: 'tag_open',
          info: '{% foo blah="asdf" %}',
          start: 10,
          end: 30,
          nesting: 1,
          meta: {
            tag: 'foo',
            attributes: [{ name: 'blah', type: 'attribute', value: 'asdf' }],
          },
        },
        { type: 'text', content: 'test', start: 31, end: 34 },
        {
          type: 'tag_close',
          nesting: -1,
          meta: { tag: 'foo' },
          info: '{% /foo %}',
          start: 35,
          end: 44,
        },
        { type: 'text', content: ' of template parsing', start: 45, end: 64 },
      ];

      expect(output).toDeepEqualSubset(expected);
    });
  });

  describe('findTagEnd', function () {
    describe('inline tags', function () {
      it('in a heading', function () {
        const example = `# Testing {% #foo.bar baz=1 %}`;
        const end = findTagEnd(example, 0);
        expect(end).toEqual(28);
        expect(example[end]).toEqual('%');
      });

      it('with string', function () {
        const example = `# Testing {% #foo.bar baz="example" test=true %}`;
        const end = findTagEnd(example, 0);
        expect(end).toEqual(46);
        expect(example[end]).toEqual('%');
      });

      it('with object literal attribute value', function () {
        const example = `# Testing {% #foo.bar baz={test: 1, foo: {test: "asdf{"}} %}`;
        const end = findTagEnd(example, 0);
        expect(end).toEqual(58);
        expect(example[end]).toEqual('%');
      });

      it('in a simple container', function () {
        const end = findTagEnd('{% foo %}');
        expect(end).toEqual(7);
      });

      it('in a container with shortcuts', function () {
        const end = findTagEnd('{% foo .bar.baz#test %}');
        expect(end).toEqual(21);
      });

      it('in a container with a string attribute', function () {
        const end = findTagEnd('{% foo test="this is a test" %}');
        expect(end).toEqual(29);
      });

      it('for an invalid container', function () {
        const end = findTagEnd('{% foo .bar#baz');
        expect(end).toBeNull();
      });

      it('in a complex container', function () {
        const end = findTagEnd(
          '{% #foo .bar .baz test="this} is \\"{test}\\" a test" %} this is a test'
        );
        expect(end).toEqual(52);
      });
    });

    describe('multiline tags', function () {
      it('simple', function () {
        const example = `
        {% test #foo.bar
              baz=1 %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(46);
        expect(example[end]).toEqual('%');
      });

      it('with string', function () {
        const example = `
        {% test #foo.bar
              baz="this is a test"
              example=1 %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(85);
        expect(example[end]).toEqual('%');
      });

      it('with string and escaped quote', function () {
        const example = `
        {% test #foo.bar
              baz="this \\"is a test"
              example=1 %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(87);
        expect(example[end]).toEqual('%');
      });

      it('with string that has an opening brace', function () {
        const example = `
        {% test #foo.bar
              baz="this {is a test"
              example=1 %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(86);
        expect(example[end]).toEqual('%');
      });

      it('with string that has escapes and braces', function () {
        const example = `
        {% test #foo.bar
              baz="th\\"is {is a \\\\te\\"st"
              example=1 %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(92);
        expect(example[end]).toEqual('%');
      });

      it('with an object literal attribute value', function () {
        const example = `
        {% test #foo.bar
              foo={testing: "this } is a test", bar: {baz: 1}}
              example=1 another="test}" %}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(129);
        expect(example[end]).toEqual('%');
      });

      it('with an invalid object literal attribute value', function () {
        const example = `
        {test #foo.bar
              foo={testing: "this } is a test", bar: {baz: 1}
              example=1 another="test}"}
        `;

        const end = findTagEnd(example, 0);
        expect(end).toEqual(null);
      });
    });
    it("shouldn't hang when {% is included in code block", () => {
      const example = '```\n{%a %b %c}\n```';

      const output = parseTags(example);
      expect(output).toEqual([
        {
          type: 'text',
          start: 0,
          end: 17,
          content: '```\n{%a %b %c}\n```',
        },
      ]);
    });
  });

  describe('parseAttributeValue', function () {
    it('reads each kind of literal', function () {
      expect(parseAttributeValue('"a b"')).toEqual('a b');
      expect(parseAttributeValue('3.5')).toEqual(3.5);
      expect(parseAttributeValue('true')).toEqual(true);
      expect(parseAttributeValue('null')).toEqual(null);
      expect(parseAttributeValue('[1, "a", [2]]')).toEqual([1, 'a', [2]]);
      expect(parseAttributeValue('{a: 1, "b": [true]}')).toEqual({
        a: 1,
        b: [true],
      });
    });

    it('reads a variable and a function as AST nodes', function () {
      expect(parseAttributeValue('$page.title')).toEqual(
        new Variable(['page', 'title'])
      );

      const fn = parseAttributeValue('includes($tags, "api")');
      expect(fn instanceof Function).toBe(true);
      expect((fn as Function).name).toEqual('includes');
      expect((fn as Function).parameters).toEqual({
        0: new Variable(['tags']),
        1: 'api',
      });

      expect(parseAttributeValue('{a: $x, b: [fn($y)]}')).toEqual({
        a: new Variable(['x']),
        b: [new Function('fn', { 0: new Variable(['y']) })],
      });
    });

    it('ignores whitespace around the value', function () {
      expect(parseAttributeValue('  42\n')).toEqual(42);
    });

    it('is undefined for text that is not one value', function () {
      expect(parseAttributeValue('')).toBeUndefined();
      expect(parseAttributeValue('abc')).toBeUndefined();
      expect(parseAttributeValue('1 2')).toBeUndefined();
      expect(parseAttributeValue('{a: }')).toBeUndefined();
      expect(parseAttributeValue('"a" %}')).toBeUndefined();
    });
  });
});
