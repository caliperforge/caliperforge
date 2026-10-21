import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { workflows } from '../push.ts'
import { dispatchable, fired } from '../triggers.ts'

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

test('a workflow whose on is an unresolved alias is waited on', () => {
  expect(workflows(tree({ 'weekly.yml': SCHEDULE, 'alias.yml': 'on: *missing\n' }))).toBe(true)
})

const HELLO =['src/hello.ts', 'greptile.json']

test('D1 no push or pull request filter takes the branch', () => {
  expect(fired(tree({ 'ci.yml': 'on:\n  push:\n    branches: [main]\n' }), 'x-next', HELLO)).toBe(false)
  expect(fired(tree({ 'ci.yml': "on:\n  pull_request:\n    paths: ['**.tex']\n" }), 'x-next', HELLO)).toBe(false)
  expect(fired(tree({ 'ci.yml': "on:\n  push:\n    paths-ignore: ['src/**', '*.json']\n" }), 'x-next', HELLO)).toBe(false)
  expect(fired(tree({ 'ci.yml': "on:\n  push:\n    tags: ['v*']\n" }), 'x-next', HELLO)).toBe(false)
})

test('D1 a bare push, a matched path or a bad yml fires', () => {
  expect(fired(tree({ 'ci.yml': 'on: push\n' }), 'x-next', HELLO)).toBe(true)
  expect(fired(tree({ 'ci.yml': "on:\n  pull_request:\n    paths: ['**.tex']\n" }), 'x-next', ['docs/a.tex'])).toBe(true)
  expect(fired(tree({ 'ci.yml': 'on:\n  push:\n    branches: [main]\n', 'broken.yml': 'on: [push\n' }), 'x-next', HELLO)).toBe(true)
})

test('dispatchable names push or pull request files with dispatch', () => {
  expect(dispatchable(tree({
    'ci.yml': 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
    'pr.yaml': 'on: [pull_request, workflow_dispatch]\n',
    'weekly.yml': SCHEDULE,
    'lint.yml': 'on: push\n',
    'broken.yml': 'on: [push\n',
  })).sort()).toEqual(['ci.yml', 'pr.yaml'])
})
