import { cpSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Post } from '../cli/watch.ts'
import type { Run } from './checks.ts'
import { FORK } from './workspace.ts'

const PLACES = {
  clone: join(homedir(), 'atelier_build'),
  derived: join(homedir(), '.cf-cache/atelier-release'),
  app: '/Applications/Atelier.app',
  web: join(homedir(), 'atelier_web'),
}

export type Places = typeof PLACES

type Step = [bin: string, args: string[], cwd: string]

const TAIL = 20

function steps(at: Places): Step[] {
  const clone: Step[] = existsSync(join(at.clone, '.git')) ? []
    : [['git', ['clone', 'https://github.com/caliperforge/atelier.git', at.clone], dirname(at.clone)]]
  return [...clone,
    ['git', ['fetch', '--no-tags', 'origin', 'main'], at.clone],
    ['git', ['checkout', '--detach', 'FETCH_HEAD'], at.clone],
    ['xcodebuild', ['-project', 'Atelier.xcodeproj', '-scheme', 'Atelier', '-configuration', 'Release',
      '-destination', 'platform=macOS', '-derivedDataPath', at.derived, 'build'], at.clone]]
}

function ranAll(all: Step[], title: string, run: Run, post: Post): boolean {
  for (const [bin, args, cwd] of all) {
    const ran = run(args, cwd, bin)
    if (!ran.ok) {
      post(title, `${bin} ${args.join(' ')}\n${ran.output.split('\n').slice(-TAIL).join('\n')}`)
      return false
    }
  }
  return true
}

export function refresh(repo: string, run: Run, post: Post, at: Places = PLACES): void {
  if (repo !== `${FORK}/atelier-web`) {
    reinstall(run, post, at)
    return
  }
  ranAll([
    ['git', ['fetch', '--no-tags', 'origin', 'main'], at.web],
    ['git', ['merge', '--ff-only', 'FETCH_HEAD'], at.web],
  ], 'CaliperForge · Atelier web did not update', run, post)
}

export function reinstall(run: Run, post: Post, at: Places = PLACES): void {
  if (!ranAll(steps(at), 'CaliperForge · Atelier did not build', run, post)) return
  run(['-e', 'quit app "Atelier"'], at.clone, 'osascript')
  rmSync(at.app, { recursive: true, force: true })
  cpSync(join(at.derived, 'Build/Products/Release/Atelier.app'), at.app, { recursive: true, verbatimSymlinks: true })
  run([at.app], at.clone, 'open')
}
