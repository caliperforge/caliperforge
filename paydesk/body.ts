import { isDeepStrictEqual } from 'node:util'

interface Schema {
  $ref?: string
  example?: unknown
  enum?: unknown[]
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
}

interface Media {
  example?: unknown
  examples?: Record<string, unknown> | unknown[]
  schema?: Schema
}

export interface Operation {
  requestBody?: { content?: Record<string, Media> }
}

export interface Spec {
  components?: { schemas?: Record<string, Schema> }
}

export function bodyCandidates(op: Operation, spec: Spec): unknown[] {
  const media = op.requestBody?.content?.['application/json']
  if (media === undefined) return [{}]
  const found = [...own(media), ...(media.schema === undefined ? [] : [build(media.schema, 0, spec)])]
  const kept = found.filter((body, i) => ![{}, ...found.slice(0, i)].some((seen) => isDeepStrictEqual(seen, body)))
  return [...kept, {}]
}

function own(media: Media): unknown[] {
  if (media.example !== undefined) return [media.example]
  const first: unknown = Object.values(media.examples ?? {})[0]
  if (first === undefined) return []
  return [typeof first === 'object' && first !== null && 'value' in first ? first.value : first]
}

function build(s: Schema, depth: number, spec: Spec): unknown {
  if (depth > 4) return 'test'
  if (s.$ref !== undefined) {
    const target = spec.components?.schemas?.[s.$ref.slice(s.$ref.lastIndexOf('/') + 1)]
    return target === undefined ? 'test' : build(target, depth + 1, spec)
  }
  if (s.example !== undefined) return s.example
  if (s.enum !== undefined && s.enum.length > 0) return s.enum[0]
  if (s.type === 'object' || s.properties !== undefined) return object(s, depth, spec)
  if (s.type === 'array') return [build(s.items ?? {}, depth + 1, spec)]
  if (s.type === 'integer' || s.type === 'number') return 1
  return s.type === 'boolean' ? true : 'test'
}

function object(s: Schema, depth: number, spec: Spec): Record<string, unknown> {
  const keys = s.required !== undefined && s.required.length > 0 ? s.required : Object.keys(s.properties ?? {}).slice(0, 3)
  return Object.fromEntries(keys.map((key) => [key, build(s.properties?.[key] ?? {}, depth + 1, spec)]))
}
