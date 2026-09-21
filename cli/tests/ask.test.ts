import { expect, test } from 'vitest'
import { askOf } from '../queue.ts'

const THEIRS = { title: 'PayKit interface drift', body: '## Ruby\n\n- [ ] expires_in 300 → 120\n- [ ] add payer' }

const CARD = '# fix(ruby,lua): default mpp.expires_in to 120 s\n\nOnly the expires_in default.\n'

test('with no card the ask is their issue', () => {
  expect(askOf(THEIRS, undefined)).toBe(`# ${THEIRS.title}\n\n${THEIRS.body}\n`)
})

test('with a card the card leads and titles the job, their issue follows as context', () => {
  const ask = askOf(THEIRS, CARD)
  expect(ask.startsWith(CARD.trimEnd())).toBe(true)
  expect(/^#\s+(.*)$/m.exec(ask)?.[1]).toBe('fix(ruby,lua): default mpp.expires_in to 120 s')
  expect(ask).toContain('### PayKit interface drift')
  expect(ask).toContain('### Ruby')
})
