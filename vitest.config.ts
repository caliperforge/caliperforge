import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['checks/*.test.ts', 'cli/tests/*.test.ts', 'store/*.test.ts', 'providers/tests/*.test.ts', 'runner/tests/*.test.ts', 'rails/*/tests/*.test.ts', 'seats/*/tests/*.test.ts', 'reviews/*/tests/*.test.ts', 'sequencer/tests/*.test.ts'] },
})
