import { expect, test } from "@playwright/test";
import { createNote, uniqueTitle, waitForNotesReady } from "./helpers";

test("without navigator.gpu, the app works fully and the AI panel stays hidden", async ({
  page,
}) => {
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
});

test("with stubbed navigator.gpu, the AI panel shows available status", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "gpu", {
      value: {},
      configurable: true,
    });
  });

  await waitForNotesReady(page);
  await expect(page.getByTestId("ai-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ai-status")).toContainText("dostępne");
});

test("mocked WebLLM download + summarize inference", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "gpu", {
      value: {},
      configurable: true,
    });

    globalThis.__createAiProvider = () => ({
      async init(onProgress) {
        onProgress({ progress: 0.3, text: "mock download" });
        await new Promise((r) => setTimeout(r, 20));
        onProgress({ progress: 1, text: "mock ready" });
      },
      async *summarize(body: string) {
        yield "Streszczenie: ";
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

  await waitForNotesReady(page);
  await expect(page.getByTestId("ai-panel")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("ai-download").click();
  await expect(page.getByTestId("ai-status")).toContainText("model gotowy", {
    timeout: 15_000,
  });

  await page.getByTestId("ai-summarize-input").fill(
    "To jest długa notatka testowa do streszczenia przez mock WebLLM.",
  );
  await page.getByTestId("ai-summarize").click();
  await expect(page.getByTestId("ai-summary-output")).toContainText("Streszczenie:", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("ai-status")).toContainText("model gotowy");
});
