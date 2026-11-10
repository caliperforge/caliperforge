import { expect, test } from 'vitest'
import type { Profile } from '../../store/profile.ts'
import { clean } from '../shape.ts'

const FIXES: Profile = { issue_ref: 'Fixes' }

test.each([
  { s: 're-enumerate HID (#307). The', rules: null, out: 're-enumerate HID. The' },
  { s: 'see (#1, #2) here', rules: null, out: 'see here' },
  { s: '[#4]', rules: null, out: '' },
  { s: 'f(x) (#3)', rules: null, out: 'f(x)' },
  { s: 'use bye() now', rules: null, out: 'use bye() now' },
  { s: 'add `hello()`.', rules: null, out: 'add `hello()`.' },
  { s: '(Fixes #307)', rules: FIXES, out: '(Fixes #307)' },
  { s: 'Fixes #35.', rules: FIXES, out: 'Fixes #35.' },
  { s: 'Fixes #35.', rules: null, out: 'Fixes.' },
  { s: '#35 asks for it.', rules: null, out: 'asks for it.' },
])('clean strips references and what they leave: $s', ({ s, rules, out }) => {
  expect(clean(s, rules)).toBe(out)
})
