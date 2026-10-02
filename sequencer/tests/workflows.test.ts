import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { workflows } from '../push.ts'

const SCHEDULE = "on:\n  schedule:\n    - cron: '0 6 * * 1'\n  workflow_dispatch:\n"

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-workflows-'))
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, '.github/workflows', name), body)
  return dir
}

test('D2 a push or pull_request workflow is waited on in any form', () => {
  expect(workflows(tree({ 'ci.yml': 'on: push\n' }))).toBe(true)
  expect(workflows(tree({ 'ci.yml': 'on: [pull_request, workflow_dispatch]\n' }))).toBe(true)
  expect(workflows(tree({ 'ci.yml': 'on:\n  push:\n    branches: [main]\n' }))).toBe(true)
})

test('D2 a tree of only scheduled or manual workflows is not', () => {
  expect(workflows(tree({ 'weekly.yml': SCHEDULE, 'manual.yaml': 'on: workflow_dispatch\n' }))).toBe(false)
})

test('D3 push beside schedule, or a bad yml, is still waited on', () => {
  expect(workflows(tree({ 'ci.yml': `${SCHEDULE}  push:\n` }))).toBe(true)
  expect(workflows(tree({ 'weekly.yml': SCHEDULE, 'broken.yml': 'on: [push\n' }))).toBe(true)
})
