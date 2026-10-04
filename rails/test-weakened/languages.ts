export interface Conventions { source: RegExp; assert: RegExp; skip: RegExp }

export const ASSERT = /\b(?:expect|assert)\s*\(/

const JAVASCRIPT: Conventions = {
  source: /\.[jt]sx?$/,
  assert: ASSERT,
  skip: /\b(?:test|it|describe)\.(?:skip|todo|failing)\b|\bx(?:it|describe)\s*\(/,
}

const LANGUAGES: Conventions[] = [
  JAVASCRIPT,
  { source: /\.swift$/, assert: /XCTAssert\w*\s*\(|#expect\s*\(/, skip: /XCTSkip/ },
  { source: /\.kts?$/, assert: /\bassert\w*\s*\(/, skip: /@Disabled|@Ignore/ },
  { source: /\.go$/, assert: /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\brequire\.\w+\s*\(/, skip: /\bt\.Skip\w*\s*\(/ },
  { source: /\.py$/, assert: /^\s*assert\b|\bself\.assert\w*\s*\(/, skip: /pytest\.mark\.skip/ },
  { source: /\.rs$/, assert: /\bassert(?:_eq|_ne)?!/, skip: /#\[ignore\b/ },
  { source: /\.php$/, assert: /\$this->assert\w*\s*\(/, skip: /markTestSkipped/ },
  { source: /\.rb$/, assert: /\b(?:expect|assert\w*)\b/, skip: /\bpending\b/ },
  { source: /\.lua$/, assert: /\bassert\.(?:are|is)\b/, skip: /\bpending\b/ },
]

export function conventionsOf(path: string): Conventions {
  return LANGUAGES.find((l) => l.source.test(path)) ?? JAVASCRIPT
}
