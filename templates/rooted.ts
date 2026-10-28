import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, planDir, srcDir } from '../sequencer/workspace.ts'

/** Copies an untracked foundry.toml with lib/forge-std to `into/root/`, which run_pair copies onto each checkout's root. */
export function rooted(src: string, into: string): void {
  if (!existsSync(join(src, 'foundry.toml')) || git(src, ['ls-files', 'foundry.toml']).trim() !== '') return
  mkdirSync(join(into, 'root'), { recursive: true })
  cpSync(join(src, 'foundry.toml'), join(into, 'root/foundry.toml'))
  if (existsSync(join(src, 'lib/forge-std'))) cpSync(join(src, 'lib/forge-std'), join(into, 'root/lib/forge-std'), { recursive: true })
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
