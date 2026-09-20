import {fileURLToPath} from "node:url";

import {defineConfig} from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Date and Intl formatting follow the machine timezone, and several
    // assertions spell out a formatted timestamp. Pinning it keeps the suite
    // identical on a developer box in UTC+8 and on CI.
    env: {TZ: "UTC"},
    exclude: ["tests/worker/**", "node_modules/**", "dist/**"],
    globals: true,
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/unit/i18n-setup.ts"],
  },
});
