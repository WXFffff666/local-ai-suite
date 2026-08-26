import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// CI hosted runners: single long-lived fork avoids per-file native-module
// reload crashes (better-sqlite3/sqlite-vec) and memory spikes.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  }),
)
