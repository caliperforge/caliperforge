import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, gitBase, maybe, planDir, remote, srcDir, tried } from '../sequencer/workspace.ts'

/** Copies an untracked foundry.toml with lib/forge-std to `into/root/`, which run_pair copies onto each checkout's root. */
export function rooted(src: string, into: string): void {
  if (!existsSync(join(src, 'foundry.toml')) || git(src, ['ls-files', 'foundry.toml']).trim() !== '') return
  mkdirSync(join(into, 'root'), { recursive: true })
  cpSync(join(src, 'foundry.toml'), join(into, 'root/foundry.toml'))
  if (existsSync(join(src, 'lib/forge-std'))) cpSync(join(src, 'lib/forge-std'), join(into, 'root/lib/forge-std'), { recursive: true })
}


export function archived(src: string, suite: string, into: string): boolean {
  if (!existsSync(join(src, suite))) return false
  cpSync(join(src, suite), into, { recursive: true })
  rooted(src, into)
  return true
}

/** Checks plan `id`'s repo out afresh into `into` at its pre_fix with its submodules, and installs `suites` as run_pair does: at `test/<target>/`, its `root/` onto the checkout's root. */
export function planted(root: string, id: number, into: string, { suites, target }: { suites: string; target: string }): void {
  const made = maybe(root, id, 'checkout.json')
  if (made === null) throw new Error(`plan ${String(id)} has no checkout.json`)
  const { repo, pre_fix: preFix } = JSON.parse(made) as { repo: string; pre_fix: string }
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  git(into, ['init', '-q'])
  git(into, ['fetch', '-q', '--depth', '1', remote(gitBase(root), repo), preFix])
  git(into, ['checkout', '-q', 'FETCH_HEAD'])
  git(into, ['submodule', 'update', '--init', '--recursive'])
  const kept = join(suites, 'root')
  cpSync(suites, join(into, 'test', target), { recursive: true, filter: (from) => from !== kept })
  if (existsSync(kept)) cpSync(kept, into, { recursive: true })
}

/** Clones `url` afresh into `bench`, keeping the `<suites>/root/` generate wrote, which `src/` loses to reap. */
export function recloned(bench: string, suites: string, url: string): void {
  const kept = join(dirname(bench), 'kept-root')
  if (existsSync(join(bench, suites, 'root'))) renameSync(join(bench, suites, 'root'), kept)
  rmSync(bench, { recursive: true, force: true })
  git(dirname(bench), ['clone', '-q', url, bench])
  mkdirSync(join(bench, suites), { recursive: true })
  if (existsSync(kept)) renameSync(kept, join(bench, suites, 'root'))
}

/** Writes `config` as the suite's medusa.json, judged against the foundry.toml run_pair's checkout holds: `root/`'s, else src's at HEAD. */
export function placed(config: unknown, src: string, suite: string): string | null {
  const carried = join(suite, 'root/foundry.toml')
  const dropped = outless(config, existsSync(carried) ? readFileSync(carried, 'utf8') : tried(src, ['show', 'HEAD:foundry.toml']) ?? '')
  writeFileSync(join(suite, 'medusa.json'), JSON.stringify(config, null, 2))
  return dropped
}

function outless(config: unknown, toml: string): string | null {
  const args = (config as { compilation?: { platformConfig?: { args?: unknown } } } | null)?.compilation?.platformConfig?.args
  if (!Array.isArray(args)) return null
  const at = args.indexOf('--foundry-out-directory')
  const dir: unknown = args[at + 1]
  if (at < 0 || typeof dir !== 'string') return null
  const outs = toml.split(/^(?=[ \t]*\[)/m).filter((section) => /^[ \t]*\[profile\.[^\]]+\]/.test(section))
    .flatMap((section) => [...section.matchAll(/^[ \t]*out[ \t]*=[ \t]*(["'])(.*?)\1/gm)].map((m) => m[2]))
  if (outs.includes(dir)) return null
  args.splice(at, 2)
  return dir
}

/** Moves the src/ a lap that died on `step` half-wrote to `src.dead-<pid>/`, so the src/ returned is cloned at pre_fix afresh. */
export function scrapped(root: string, id: number, step: number): string {
  const dir = planDir(root, id)
  for (const name of readdirSync(dir)) {
    const pid = new RegExp(`^step-${String(step)}\\.dead-(\\d+)\\.transcript\\.jsonl$`).exec(name)?.[1]
    if (pid === undefined || !existsSync(join(dir, 'src')) || existsSync(join(dir, `src.dead-${pid}`))) continue
    renameSync(join(dir, 'src'), join(dir, `src.dead-${pid}`))
  }
  return srcDir(root, id)
}
