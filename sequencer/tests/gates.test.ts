import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gates, outsideLanguage } from '../gates.ts'

function fixture(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-gates-'))
  mkdirSync(join(dir, marker, '..'), { recursive: true })
  writeFileSync(join(dir, marker), '')
  return dir
}

test('D1 kotlin and swift are outside languages', () => {
  expect(outsideLanguage('kotlin')).toBe('kotlin')
  expect(outsideLanguage('swift')).toBe('swift')
})

test('D2 kotlin with no Justfile runs gradle in its folder', () => {
  expect(gates(fixture('kotlin/build.gradle.kts'), { language: 'kotlin', files: ['kotlin/src/main/kotlin/Runner.kt'] }))
    .toEqual([{ script: 'test', bin: 'gradle', args: ['installDist', 'test'], dir: 'kotlin' }])
})

test('D3 swift with no Justfile builds, then tests, in its folder', () => {
  expect(gates(fixture('swift/Package.swift'), { language: 'swift', files: ['swift/Sources/PayKit/Memo.swift'] })).toEqual([
    { script: 'build', bin: 'swift', args: ['build'], dir: 'swift' },
    { script: 'test', bin: 'swift', args: ['test'], dir: 'swift' },
  ])
})
