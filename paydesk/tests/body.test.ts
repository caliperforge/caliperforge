import { expect, test } from 'vitest'
import { bodyCandidates, type Operation, type Spec } from '../body.ts'

function op(media: object): Operation {
  return { requestBody: { content: { 'application/json': media } } }
}

function built(schema: object, spec: Spec = {}): unknown {
  return bodyCandidates(op({ schema }), spec)[0]
}

test('the example comes before the built body', () => {
  expect(bodyCandidates(op({ example: { a: 1 } }), {})).toEqual([{ a: 1 }, {}])
  expect(bodyCandidates(op({ example: { a: 1 }, schema: { type: 'integer' } }), {})).toEqual([{ a: 1 }, 1, {}])
})

test('an examples entry gives its value, or itself', () => {
  expect(bodyCandidates(op({ examples: { x: { value: { b: 2 } } } }), {})).toEqual([{ b: 2 }, {}])
  expect(bodyCandidates(op({ examples: { x: { c: 3 } } }), {})).toEqual([{ c: 3 }, {}])
})

test('a $ref resolves to its component, else builds test', () => {
  const spec = { components: { schemas: { Pet: { properties: { name: { type: 'string' } } } } } }
  expect(built({ $ref: '#/components/schemas/Pet' }, spec)).toEqual({ name: 'test' })
  expect(built({ $ref: '#/components/schemas/Gone' }, spec)).toBe('test')
})

test('a self-referencing schema stops at depth 4', () => {
  const Node = { properties: { child: { $ref: '#/components/schemas/Node' } }, required: ['child'] }
  expect(built({ $ref: '#/components/schemas/Node' }, { components: { schemas: { Node } } })).toEqual({
    child: { child: 'test' },
  })
})

test('required keys, else the first three properties', () => {
  const properties = { a: { type: 'integer' }, b: { type: 'boolean' }, c: {}, d: {} }
  expect(built({ properties, required: ['b'] })).toEqual({ b: true })
  expect(built({ type: 'object', properties })).toEqual({ a: 1, b: true, c: 'test' })
})

test('leaf types build their dummy values', () => {
  expect(built({ enum: ['cat', 'dog'], type: 'string' })).toBe('cat')
  expect(built({ example: 'rex', type: 'integer' })).toBe('rex')
  expect(built({ type: 'array', items: { type: 'number' } })).toEqual([1])
  expect(built({ type: 'integer' })).toBe(1)
  expect(built({ type: 'number' })).toBe(1)
  expect(built({ type: 'boolean' })).toBe(true)
  expect(built({ type: 'string' })).toBe('test')
})

test('an example equal to the built body appears once', () => {
  const media = { example: { n: 1 }, schema: { properties: { n: { type: 'integer' } } } }
  expect(bodyCandidates(op(media), {})).toEqual([{ n: 1 }, {}])
})

test('every result ends with exactly one {}', () => {
  expect(bodyCandidates({}, {})).toEqual([{}])
  expect(bodyCandidates(op({ example: {} }), {})).toEqual([{}])
  expect(bodyCandidates(op({ example: {}, schema: { type: 'object' } }), {})).toEqual([{}])
})
