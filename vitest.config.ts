import { fileURLToPath, URL } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**", "server/**"],
      exclude: ["src/components/ui/**", "src/**/*.test.*", "e2e/**"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.{test,spec}.ts", "server/**/*.{test,spec}.ts"],
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
