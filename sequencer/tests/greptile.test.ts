import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { config } from '../greptile.ts'

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-greptile-'))
  mkdirSync(join(dir, 'profiles/solana-foundation'), { recursive: true })
  writeFileSync(join(dir, 'profiles/solana-foundation/pay-kit.yml'), 'greptile_files: [docs/paykit-interface.md]\n')
  mkdirSync(join(dir, 'reviews/examples'), { recursive: true })
  writeFileSync(join(dir, 'reviews/examples/python.md'), '# Python\n\n- pay-kit#1 `a`: one (l1).\n- widget#3 `w`: other (l3).\n')
  return dir
}

const read = (dir: string, repo: string): unknown => JSON.parse(config(dir, repo))

test('D1 pay-kit carries its files, strictness 1, no autoReview', () => {
  expect(read(root(), 'solana-foundation/pay-kit')).toMatchObject({ autoReview: [], strictness: 1,
    customContext: { files: [{ path: 'docs/paykit-interface.md', scope: ['**'] }] } })
})

test('D2 pay-kit example lines from both folders become rules', () => {
  const dir = root()
  mkdirSync(join(dir, '.cf/examples'), { recursive: true })
  writeFileSync(join(dir, '.cf/examples/go.md'), '- pay-kit#2 `b`: two (l2).\n- pay-kit#4 `c`: four (l4).\n')
  expect(read(dir, 'solana-foundation/pay-kit')).toMatchObject({ customContext: { rules: [
    { rule: 'pay-kit#1 `a`: one (l1).', scope: ['**'] },
    { rule: 'pay-kit#2 `b`: two (l2).', scope: ['**'] },
    { rule: 'pay-kit#4 `c`: four (l4).', scope: ['**'] },
  ] } })
})

test('D3 no profile, no examples and no .cf folder: empty context', () => {
  expect(read(root(), 'acme/kit')).toEqual({ autoReview: [], strictness: 1, customContext: { rules: [], files: [] } })
})
