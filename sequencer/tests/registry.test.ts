import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { registered } from '../../runner/rules.ts'
import { Entry, mechanisms } from '../drift.ts'

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  mkdirSync(join(dir, 'rules/registry'), { recursive: true })
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  return dir
}

test('checkoutMatchesFixture', () => {
  const fixture = readFileSync(join(import.meta.dirname, 'fixtures/registry.yaml'), 'utf8')
  expect(mechanisms(join(import.meta.dirname, '../..'))).toEqual(Entry.array().parse(parse(fixture)))
})

test('checkoutJoinsToFixture', () => {
  const repo = join(import.meta.dirname, '../..')
  const joined = registered(repo).map((path) => readFileSync(join(repo, path), 'utf8')).join('')
  expect(joined).toBe(readFileSync(join(import.meta.dirname, 'fixtures/registry.yaml'), 'utf8'))
})

test('registryFileIgnored', () => {
  const dir = root({
    'rules/registry.yaml': '- name: a\n',
    'rules/registry/01-c.yaml': '- name: c\n',
    'rules/registry/00-b.yaml': '- name: b\n',
    'rules/registry/notes.md': '- name: d\n',
  })
  expect(registered(dir)).toEqual(['rules/registry/00-b.yaml', 'rules/registry/01-c.yaml'])
  expect(mechanisms(dir).map((e) => e.name)).toEqual(['b', 'c'])
})

test('folderAlone', () => {
  expect(registered(root({ 'rules/registry/00-b.yaml': '- name: b\n' }))).toEqual(['rules/registry/00-b.yaml'])
})

test('badEntryThrows', () => {
  expect(() => mechanisms(root({ 'rules/registry/00-b.yaml': '- name: b\n  gap: 2w\n' }))).toThrow()
})
