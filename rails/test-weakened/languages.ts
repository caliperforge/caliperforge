export interface Conventions { source: RegExp; assert: RegExp; skip: RegExp; comment: RegExp; title: RegExp }

export const ASSERT = /\b(?:expect|assert)\s*\(/
export const QUOTED = /\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1/.source
export const TITLE = new RegExp(`\\b(?:test|it|describe)${QUOTED}`)

const SLASHES = /^\s*(?:\/\/|\/\*|\*)/
const HASH = /^\s*#/

const JAVASCRIPT: Conventions = {
  source: /\.[jt]sx?$/,
  assert: ASSERT,
  skip: /\b(?:test|it|describe)\.(?:skip|todo|failing)\b|\bx(?:it|describe)\s*\(/,
  comment: SLASHES,
  title: TITLE,
}

const LANGUAGES: Conventions[] = [
  JAVASCRIPT,
  { source: /\.swift$/, assert: /XCTAssert\w*\s*\(|#expect\s*\(/, skip: /XCTSkip/, comment: SLASHES, title: TITLE },
  { source: /\.kts?$/, assert: /\bassert\w*\s*\(/, skip: /@Disabled|@Ignore/, comment: SLASHES, title: TITLE },
  { source: /\.go$/, assert: /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\brequire\.\w+\s*\(/, skip: /\bt\.Skip\w*\s*\(/, comment: SLASHES, title: /^\s*func\s+(Test\w*)\s*\(/ },
  { source: /\.py$/, assert: /^\s*assert\b|\bself\.assert\w*\s*\(/, skip: /pytest\.mark\.skip/, comment: HASH, title: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/ },
  { source: /\.rs$/, assert: /\bassert(?:_eq|_ne)?!/, skip: /#\[ignore\b/, comment: SLASHES, title: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/ },
  { source: /\.php$/, assert: /\$this->assert\w*\s*\(/, skip: /markTestSkipped/, comment: /^\s*(?:\/\/|\/\*|\*|#)/, title: TITLE },
  { source: /\.rb$/, assert: /\b(?:expect|assert\w*)\b/, skip: /\bpending\b/, comment: HASH, title: TITLE },
  { source: /\.lua$/, assert: /\bassert\.(?:are|is)\b/, skip: /\bpending\b/, comment: /^\s*--/, title: TITLE },
]

export function conventionsOf(path: string): Conventions {
  return LANGUAGES.find((l) => l.source.test(path)) ?? JAVASCRIPT
}
