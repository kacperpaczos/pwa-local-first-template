import { fileURLToPath, URL } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

/**
 * One project per test layer — see "Test layers" in docs/architecture.md.
 * The layer decides what is real and what is a stand-in, so it is expressed
 * as a project (own name, own command) rather than a file-naming convention.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**", "server/**"],
      // src/testing/** is the test harness, not product code.
      exclude: ["src/components/ui/**", "src/**/*.test.*", "src/testing/**", "e2e/**"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.{test,spec}.ts", "server/**/*.{test,spec}.ts"],
          // The layered projects below own these; without the exclude, `unit`
          // would run them a second time.
          exclude: ["src/**/*.contract.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "contract",
          environment: "node",
          include: ["src/**/*.contract.test.ts"],
        },
      },
      {
        plugins: [solid()],
        // Solid must resolve its client (browser) build under jsdom, or
        // components throw "client-only API called on the server".
        resolve: { alias, conditions: ["development", "browser"] },
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.{test,spec}.tsx"],
          setupFiles: ["./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
