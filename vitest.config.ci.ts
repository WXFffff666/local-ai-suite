import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// CI hosted runners: better-sqlite3 / tray(electron) suites abort the vitest
// fork during IMPORT on hosted images (passes locally). They run isolated in
// the dedicated 'test-native' job (see ci.yml) until root-caused.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      fileParallelism: false,
      exclude: [...(baseConfig.test?.exclude ?? []), 'src/main/storage/**', 'src/main/tray/**'],
    },
  }),
)
