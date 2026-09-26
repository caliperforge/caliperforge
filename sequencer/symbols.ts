import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { git, repoName } from './workspace.ts'

const patterns: [string[], RegExp][] = [
  [
    ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    /^export\s+(?:(?:default|declare|abstract|async)\s+)*(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  ],
  [['rs'], /^pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const)\s+)*(?:fn|struct|enum|trait|type|const|static|mod|union)\s+([A-Za-z_]\w*)/],
  [['go'], /^(?:func(?:\s*\([^)]*\))?|type|var|const)\s+([A-Z]\w*)/],
  [['py'], /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/],
  [['kt', 'kts'], /^(?:(?!private\b)[a-z]+\s+)*(?:fun|class|interface|object|val|var|typealias)\s+([A-Za-z_]\w*)/],
  [['swift'], /^(?:public|open)\s+(?:func|class|struct|enum|protocol|let|var|typealias)\s+([A-Za-z_]\w*)/],
  [['java'], /^public\s+(?:(?:final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/],
  [['rb'], /^(?:class|module|def)\s+([\w.:]+[?!]?)/],
  [['php'], /^(?:(?:final|abstract|readonly)\s+)*(?:class|interface|trait|enum|function)\s+([A-Za-z_]\w*)/],
]

export function symbolMap(root: string, repo: string, dir: string, sha: string): string {
  const cache = join(root, '.cf/maps', `${repoName(repo)}@${sha}`)
  if (existsSync(cache)) return readFileSync(cache, 'utf8')
  const text = git(dir, ['ls-tree', '-r', '--name-only', '-z', sha])
    .split('\0')
    .sort()
    .flatMap((path) => symbols(dir, sha, path))
    .map((row) => `${row}\n`)
    .join('')
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, text)
  return text
}

function symbols(dir: string, sha: string, path: string): string[] {
  const pattern = patterns.find(([extensions]) => extensions.includes(extname(path).slice(1)))?.[1]
  if (pattern === undefined) return []
  return git(dir, ['show', `${sha}:${path}`])
    .split('\n')
    .flatMap((line, i) => {
      const name = pattern.exec(line)?.[1]
      return name === undefined ? [] : [`${path}:${String(i + 1)} ${name}`]
    })
}
