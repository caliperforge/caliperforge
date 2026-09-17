import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['checks/*.test.ts', 'store/*.test.ts', 'runner/tests/*.test.ts', 'rails/*/tests/*.test.ts', 'seats/*/tests/*.test.ts', 'reviews/*/tests/*.test.ts'] },
})
