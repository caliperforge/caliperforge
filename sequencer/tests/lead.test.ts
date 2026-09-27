import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { CHECK } from '../../cli/find.ts'
import { CARD } from '../../cli/queue.ts'
import { lead } from '../lead.ts'
import { put, srcDir } from '../workspace.ts'
import { world, type World } from './world.ts'

function at(part: string, ask: string, paths: string[] = []): World {
  const w = world()
  w.db.prepare('UPDATE targets SET part = ? WHERE id = 1').run(part)
  put(w.root, 1, 'ask.md', ask)
  for (const path of paths) {
    const file = join(srcDir(w.root, 1), path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x\n')
  }
  return w
}

const THREE = '# three\n\n- fix `src/a.ts`.\n* fix `src/b.ts`\n1. fix `lib/c.ts`\n'

test('D1 no part over several leads is a flag, whatever the diff', () => {
  const w = at('', THREE, ['src/a.ts'])
  expect(lead(w.db, w.root, 1)).toEqual({ check: 'lead', ok: false, says: 'the target claims the whole issue of 3 leads' })
})

test('D2 a part whose diff touches one lead passes, a name on a line under the lead counting for it', () => {
  const w = at('fix-b', '# two\n\n- fix a in `src/a.ts`\n- fix b\n  in `src/b.ts`\n', ['src/b.ts', 'README'])
  expect(lead(w.db, w.root, 1)).toEqual({ check: 'lead', ok: true, says: 'covers fix-b, one of 2 lead(s)' })
})

test('D3 a part whose diff touches two leads is a flag naming them in issue order', () => {
  const w = at('fix-a', THREE, ['pkg/src/a.ts', 'lib/c.ts'])
  expect(lead(w.db, w.root, 1)).toEqual({ check: 'lead', ok: false, says: 'covers fix-a but touches leads 1, 3' })
})

test('D4 no part over at most one lead passes', () => {
  const one = at('', '# hello\n\n- **D1** add `hello()` in `src/hello.ts`\n')
  expect(lead(one.db, one.root, 1)).toEqual({ check: 'lead', ok: true, says: 'whole issue, 1 lead(s)' })
  const none = at('', '# prose\n\nno list here\n')
  expect(lead(none.db, none.root, 1)).toEqual({ check: 'lead', ok: true, says: 'whole issue, 0 lead(s)' })
})

test('D5 our card, the target check and the fixer answer hold no leads', () => {
  const ask = `# card\n\n- D1 fix \`src/a.ts\`\n- D2 fix \`src/b.ts\`\n\n${CARD}\n\n### theirs\n\n- fix \`src/a.ts\`\n\n${CHECK}\n\n- \`src/b.ts\` checked\n`
  const w = at('', ask)
  expect(lead(w.db, w.root, 1).says).toBe('whole issue, 1 lead(s)')
  const fixed = at('', `${THREE}\n## Answer from the fixer, round 1\n\n- \`src/d.ts\`\n`)
  expect(lead(fixed.db, fixed.root, 1).says).toBe('the target claims the whole issue of 3 leads')
})

test('D5 a path two leads both name counts for neither', () => {
  const w = at('fix-a', '# shared\n\n- fix `src/a.ts` and `src/shared.ts`\n- fix `src/shared.ts`\n', ['src/a.ts', 'src/shared.ts'])
  expect(lead(w.db, w.root, 1)).toEqual({ check: 'lead', ok: true, says: 'covers fix-a, one of 2 lead(s)' })
})
