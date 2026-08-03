import { expect, test } from "@playwright/test";
import { createNote, uniqueTitle, waitForNotesReady } from "./helpers";

async function waitForAiPage(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/ai");
  await expect(
    page.getByTestId("ai-panel").or(page.getByTestId("ai-unavailable")),
  ).toBeVisible({ timeout: 30_000 });
}

test("without navigator.gpu, notes work and AI stays unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "gpu", {
      value: undefined,
      configurable: true,
    });
  });

  await waitForNotesReady(page);
  await expect(page.getByTestId("ai-panel")).toHaveCount(0);

  const title = uniqueTitle("No-WebGPU note");
  await createNote(page, title);
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  // In-app navigation — avoid page.goto() remounting DbProvider / OPFS.
  await page.getByRole("link", { name: "AI" }).click();
  await expect(page.getByTestId("ai-unavailable")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("ai-panel")).toHaveCount(0);
});

test("with stubbed navigator.gpu, the AI page shows available status", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "gpu", {
      value: {
        requestAdapter: async () => ({
          limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 },
          info: { vendor: "mock", architecture: "mock" },
        }),
      },
      configurable: true,
    });
  });

  await waitForAiPage(page);
  await expect(page.getByTestId("ai-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-status")).toContainText("available");
});

test("mocked WebLLM download + summarize inference", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "gpu", {
      value: {
        requestAdapter: async () => ({
          limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 },
          info: { vendor: "mock", architecture: "mock" },
        }),
      },
      configurable: true,
    });

    globalThis.__createAiProvider = () => ({
      async init(onProgress) {
        onProgress({ progress: 0.3, text: "mock download" });
        await new Promise((r) => setTimeout(r, 20));
        onProgress({ progress: 1, text: "mock ready" });
      },
      async *chat(message: string) {
        yield "Chat: ";
        yield message.slice(0, 16);
      },
      async *summarize(body: string) {
        yield "Summary: ";
        yield body.slice(0, 24);
      },
      async suggestMeta() {
        return { title: "t", tags: ["x"] };
      },
      async *answer() {
        yield "ok";
      },
      async dispose() {},
    });
  });

  await waitForAiPage(page);
  await expect(page.getByTestId("ai-panel")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("ai-download").click();
  await expect(page.getByTestId("ai-status")).toContainText("model ready", {
    timeout: 15_000,
  });

  await page.getByTestId("ai-mode-summarize").click();
  const noteBody = "This is a long test note to summarize via mock WebLLM.";
  await page.getByTestId("ai-summarize-input").fill(noteBody);
  await page.getByTestId("ai-summarize").click();
  await expect(page.getByTestId("ai-summary-output")).toHaveText(
    `Summary: ${noteBody.slice(0, 24)}`,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("ai-status")).toContainText("model ready");
});
