import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { section } from './brief.ts'
import { npm, type Run } from './checks.ts'
import type { Outcome } from './kind.ts'
import { get, srcDir } from './workspace.ts'

const PIN = /^- `((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`$/

const Package = z.object({ dependencies: z.record(z.string(), z.string()).default({}) })

/** The brief's `## Pinned` packages installed at their exact versions before the build, or the first row that is not one held. */
export function added(db: Db, root: string, plan: number, run: Run = npm): Outcome | null {
  const src = srcDir(root, plan)
  const pins: [string, string][] = []
  for (const row of section(get(root, plan, 'issue.md'), '## Pinned').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const hit = PIN.exec(row)
    if (hit === null) return held(db, plan, [row], `pinned: ${row}: not - \`<name>@<x.y.z>\``)
    pins.push([String(hit[1]), String(hit[2])])
  }
  if (pins.length === 0 || !existsSync(join(src, 'package.json'))) return null
  const have = Package.parse(JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))).dependencies
  const specs = pins.filter(([name, version]) => have[name] !== version).map(([name, version]) => `${name}@${version}`)
  if (specs.length === 0) return null
  const command = `npm install --save-exact ${specs.join(' ')}`
  const got = run(['install', '--save-exact', ...specs], src)
  if (!got.ok) return { ...held(db, plan, ['## Pinned'], `pinned: ${command} exited ${got.code}`), message: got.output }
  logged(db, { plan, kind: 'pinned', actor: 'machine', outcome: 'pass', message: command, pointer: null, run: null })
  return null
}

function held(db: Db, plan: number, spans: string[], note: string): Outcome {
  logged(db, { plan, kind: 'pinned', actor: 'machine', outcome: 'needs_ceo', message: note, pointer: null, run: null })
  return { outcome: 'needs_ceo', spans, note }
}
