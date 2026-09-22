const DECL = /\b(?:func|fun)\s+(?!interface\b)[A-Za-z_`]/
const RAW = '"""'

export interface Declaration {
  line: number
  end: number
  nesting: number
  expression: boolean
}

export interface Scan {
  declarations: Declaration[]
  balanced: boolean
}

export function scan(text: string): Scan {
  const state = walk(text)
  return {
    declarations: found(state.rows, state.braces),
    balanced: state.stack.length === 0 && state.comment === 0 && !state.broke,
  }
}

interface Brace {
  open: number
  close: number
  column: number
  inner: number
}

interface Frame {
  record: Brace
  max: number
}

interface State {
  rows: string[]
  code: string
  braces: Brace[]
  stack: Frame[]
  comment: number
  quote: string
  broke: boolean
}

function walk(text: string): State {
  const state: State = { rows: [], code: '', braces: [], stack: [], comment: 0, quote: '', broke: false }
  for (const [index, raw] of text.split('\n').entries()) {
    state.code = ''
    let at = 0
    while (at < raw.length) at = step(state, raw, at, index + 1)
    state.rows.push(state.code)
    if (state.quote !== RAW) state.quote = ''
  }
  return state
}

function step(state: State, raw: string, at: number, line: number): number {
  const two = raw.slice(at, at + 2)
  if (state.comment > 0) return commented(state, two, at)
  if (state.quote !== '') return quoted(state, raw, at)
  if (two === '/*') {
    state.comment += 1
    return at + 2
  }
  if (two === '//') return raw.length
  const quote = opening(raw, at)
  if (quote !== '') {
    state.quote = quote
    return at + quote.length
  }
  const ch = raw[at] ?? ''
  brace(state, ch, line)
  state.code += ch
  return at + 1
}

function commented(state: State, two: string, at: number): number {
  if (two === '/*') state.comment += 1
  else if (two === '*/') state.comment -= 1
  else return at + 1
  return at + 2
}

function quoted(state: State, raw: string, at: number): number {
  if (state.quote !== RAW && raw[at] === '\\') return at + 2
  if (!raw.startsWith(state.quote, at)) return at + 1
  const width = state.quote.length
  state.quote = ''
  return at + width
}

function opening(raw: string, at: number): string {
  if (raw.startsWith(RAW, at)) return RAW
  const ch = raw[at]
  return ch === '"' || ch === "'" ? ch : ''
}

function brace(state: State, ch: string, line: number): void {
  if (ch === '{') {
    const record = { open: line, close: line, column: state.code.length, inner: 0 }
    state.braces.push(record)
    state.stack.push({ record, max: state.stack.length + 1 })
    return
  }
  if (ch !== '}') return
  const frame = state.stack.pop()
  if (frame === undefined) {
    state.broke = true
    return
  }
  frame.record.close = line
  frame.record.inner = frame.max - state.stack.length - 1
  const above = state.stack.at(-1)
  if (above !== undefined) above.max = Math.max(above.max, frame.max)
}

function found(rows: string[], braces: Brace[]): Declaration[] {
  const out: Declaration[] = []
  for (const [index, code] of rows.entries()) {
    const head = DECL.exec(code)
    if (head === null) continue
    const line = index + 1
    const from = head.index + head[0].length
    if ((code.split('{')[0] ?? '').includes('=')) {
      out.push({ line, end: line, nesting: 0, expression: true })
      continue
    }
    const body = braces.find((b) => b.open > line || (b.open === line && b.column >= from))
    if (body !== undefined && owns(rows, line, from, body)) out.push({ line, end: body.close, nesting: body.inner, expression: false })
  }
  return out
}

/** A signature that reaches a closing brace or a further declaration first has no body: the brace is the next one's. */
function owns(rows: string[], line: number, from: number, body: Brace): boolean {
  const head = body.open === line ? '' : (rows[line - 1] ?? '').slice(from)
  const tail = (rows[body.open - 1] ?? '').slice(body.open === line ? from : 0, body.column)
  const gap = [head, ...rows.slice(line, body.open - 1), tail].join('\n')
  return !gap.includes('}') && !DECL.test(gap)
}
