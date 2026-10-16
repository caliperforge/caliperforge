import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { askOf, CARD as THEIR_ISSUE } from '../queue.ts'

const THEIRS = { title: 'PayKit interface drift', body: '## Ruby\n\n- [ ] expires_in 300 → 120\n- [ ] add payer' }

const CARD = '# fix(ruby,lua): default mpp.expires_in to 120 s\n\nOnly the expires_in default.\n'

test('with no card the ask is their issue', () => {
  expect(askOf(THEIRS, undefined)).toBe(`# ${THEIRS.title}\n\n${THEIRS.body}\n`)
})

test('the card leads and titles the job; their issue is context', () => {
  const ask = askOf(THEIRS, CARD)
  expect(ask.startsWith(CARD.trimEnd())).toBe(true)
  expect(/^#\s+(.*)$/m.exec(ask)?.[1]).toBe('fix(ruby,lua): default mpp.expires_in to 120 s')
  expect(ask).toContain('### PayKit interface drift')
  expect(ask).toContain('### Ruby')
})

const RULES = '- One fix per PR (source: https://example.com/CONTRIBUTING.md)\n'

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'house-'))
  mkdirSync(join(dir, 'house', 'acme'), { recursive: true })
  writeFileSync(join(dir, 'house', 'acme', 'widget.md'), RULES)
  return dir
}

test('D1 house rules sit between the card and their issue', () => {
  const ask = askOf(THEIRS, CARD, { root: root(), repo: 'acme/widget' })
  const at = [CARD.trimEnd(), '## House rules for acme/widget', `\n\n${RULES.trimEnd()}\n\n`, THEIR_ISSUE, `### ${THEIRS.title}`]
    .map((s) => ask.indexOf(s))
  expect(at).not.toContain(-1)
  expect(at).toEqual([...at].sort((a, b) => a - b))
})

test('D2 a repo with no house file gets no section', () => {
  const ask = askOf(THEIRS, CARD, { root: root(), repo: 'acme/gadget' })
  expect(ask).toBe(askOf(THEIRS, CARD))
  expect(ask).not.toContain('## House rules')
})

test('D3 with no card the ask is their issue, house file or not', () => {
  expect(askOf(THEIRS, undefined, { root: root(), repo: 'acme/widget' })).toBe(`# ${THEIRS.title}\n\n${THEIRS.body}\n`)
})
