/** Each word is read as gh's flag parser reads it: `-iXPOST` is `-i -X POST`, and a short cluster it cannot read is a write. */
export function ghWrite(command: string): boolean {
  if (!/^gh(?:\s|$)/.test(command)) return false
  const [, sub, ...rest] = words(command) ?? []
  if (sub !== 'api') return true
  return rest.some((word, i) => {
    const long = /^--([^=]+)(?:=(.*))?$/s.exec(word)
    if (long !== null) return ['field', 'raw-field', 'input'].includes(long[1] ?? '') || (long[1] === 'method' && (long[2] ?? rest[i + 1]) !== 'GET')
    if (!word.startsWith('-')) return false
    const short = /^-[hi]*(?:([XfFHpqt])(?:=(?=.))?(.*))?$/s.exec(word)
    if (short === null || short[1] === 'f' || short[1] === 'F') return true
    return short[1] === 'X' && (short[2] === '' ? rest[i + 1] : short[2]) !== 'GET'
  })
}

/** Quoted, escaped or bare text, a gap between words, or a glob or brace the shell could expand into a flag. */
const WORD = /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|([^\s'"\\{*?[]+)|(\s+)|(.)/gs

function words(command: string): string[] | null {
  const said: string[] = []
  let word = ''
  for (const [, single, double, escaped, plain, gap] of command.matchAll(WORD)) {
    const text = single ?? double ?? escaped ?? plain
    if (gap !== undefined) {
      said.push(word)
      word = ''
    } else if (text === undefined) return null
    else word += text
  }
  return [...said, word]
}
