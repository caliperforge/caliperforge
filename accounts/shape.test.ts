import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const root = import.meta.dirname
const read = (name: string): string => readFileSync(`${root}/${name}`, 'utf8')
const headings = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('## '))
const shape = headings(/```markdown\n([\s\S]*?)```/.exec(read('README.md'))?.[1] ?? '')

function missing(text: string): string[] {
  const found = headings(text)
  let at = 0
  return shape.filter((heading) => {
    const i = found.indexOf(heading, at)
    if (i < 0) return true
    at = i + 1
    return false
  })
}

test('every account file has the README sections in order', () => {
  expect(shape).toEqual(['## People', '## Repos and channels', '## Needs', '## Open work', '## Rules', '## Log'])
  for (const name of readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    expect([name, missing(read(name))]).toEqual([name, []])
  }
})

test('a file without its Log section is reported missing it', () => {
  expect(missing(read('evm-security.md').replace('## Log\n', ''))).toEqual(['## Log'])
})
