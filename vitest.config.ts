import { defineConfig } from 'vitest/config'

export default defineConfig({
  // git-spawning suites take 1–3 s a test alone and passed 5 s under load on the laptop (#70)
  test: { testTimeout: 30_000, include: ['checks/*.test.ts', 'cli/tests/*.test.ts', 'store/*.test.ts', 'providers/**/tests/*.test.ts', 'runner/tests/*.test.ts', 'rails/*/tests/*.test.ts', 'seats/*/tests/*.test.ts', 'reviews/*/tests/*.test.ts', 'sequencer/tests/*.test.ts'] },
})
