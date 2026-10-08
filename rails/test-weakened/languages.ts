export interface Conventions { source: RegExp; assert: RegExp; skip: RegExp; comment: RegExp }

export const ASSERT = /\b(?:expect|assert)\s*\(/

const SLASHES = /^\s*(?:\/\/|\/\*|\*)/
const HASH = /^\s*#/

const JAVASCRIPT: Conventions = {
  source: /\.[jt]sx?$/,
  assert: ASSERT,
  skip: /\b(?:test|it|describe)\.(?:skip|todo|failing)\b|\bx(?:it|describe)\s*\(/,
  comment: SLASHES,
}

const LANGUAGES: Conventions[] = [
  JAVASCRIPT,
  { source: /\.swift$/, assert: /XCTAssert\w*\s*\(|#expect\s*\(/, skip: /XCTSkip/, comment: SLASHES },
  { source: /\.kts?$/, assert: /\bassert\w*\s*\(/, skip: /@Disabled|@Ignore/, comment: SLASHES },
  { source: /\.go$/, assert: /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\brequire\.\w+\s*\(/, skip: /\bt\.Skip\w*\s*\(/, comment: SLASHES },
  { source: /\.py$/, assert: /^\s*assert\b|\bself\.assert\w*\s*\(/, skip: /pytest\.mark\.skip/, comment: HASH },
  { source: /\.rs$/, assert: /\bassert(?:_eq|_ne)?!/, skip: /#\[ignore\b/, comment: SLASHES },
  { source: /\.php$/, assert: /\$this->assert\w*\s*\(/, skip: /markTestSkipped/, comment: /^\s*(?:\/\/|\/\*|\*|#)/ },
  { source: /\.rb$/, assert: /\b(?:expect|assert\w*)\b/, skip: /\bpending\b/, comment: HASH },
  { source: /\.lua$/, assert: /\bassert\.(?:are|is)\b/, skip: /\bpending\b/, comment: /^\s*--/ },
]

export function conventionsOf(path: string): Conventions {
  return LANGUAGES.find((l) => l.source.test(path)) ?? JAVASCRIPT
}
