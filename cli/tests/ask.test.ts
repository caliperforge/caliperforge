import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { askOf, CARD as LINE } from '../queue.ts'

const ROOT = join(import.meta.dirname, '../..')

const BARE = 'solana-foundation/pay-kit'

const THEIRS = { title: 'PayKit interface drift', body: '## Ruby\n\n- [ ] expires_in 300 → 120\n- [ ] add payer' }

const CARD = '# fix(ruby,lua): default mpp.expires_in to 120 s\n\nOnly the expires_in default.\n'

const PYVO = readFileSync(join(ROOT, 'house/astropy/pyvo.md'), 'utf8').trimEnd()

test('with no card the ask is their issue', () => {
  expect(askOf(THEIRS, undefined, ROOT, BARE)).toBe(`# ${THEIRS.title}\n\n${THEIRS.body}\n`)
})

test('the card leads and titles the job; their issue is context', () => {
  const ask = askOf(THEIRS, CARD, ROOT, BARE)
  expect(ask.startsWith(CARD.trimEnd())).toBe(true)
  expect(/^#\s+(.*)$/m.exec(ask)?.[1]).toBe('fix(ruby,lua): default mpp.expires_in to 120 s')
  expect(ask).toContain('### PayKit interface drift')
  expect(ask).toContain('### Ruby')
})

test('house rules sit between the card and their issue', () => {
  const ask = askOf(THEIRS, CARD, ROOT, 'astropy/pyvo')
  const at = ask.indexOf('## House rules for astropy/pyvo')
  expect(ask).toContain(`## House rules for astropy/pyvo\n\n${PYVO}`)
  expect(ask.indexOf(CARD.trimEnd()) + CARD.trimEnd().length).toBeLessThan(at)
  expect(at).toBeLessThan(ask.indexOf(LINE))
})

test('a repo with no house file gets no section', () => {
  expect(askOf(THEIRS, CARD, ROOT, BARE)).not.toContain('## House rules')
  expect(askOf(THEIRS, undefined, ROOT, BARE)).not.toContain('## House rules')
})

test('with no card house rules precede their title', () => {
  const ask = askOf(THEIRS, undefined, ROOT, 'astropy/pyvo')
  expect(ask.indexOf('## House rules for astropy/pyvo')).toBeLessThan(ask.indexOf(`# ${THEIRS.title}`))
  expect(/^#\s+(.*)$/m.exec(ask)?.[1]).toBe(THEIRS.title)
})
