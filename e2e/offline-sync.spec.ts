import { expect, test } from "@playwright/test";
import {
  createNote,
  expectNoteVisible,
  openTwoPeers,
  resetRelay,
  syncNow,
  uniqueTitle,
} from "./helpers";

test.beforeEach(async () => {
  await resetRelay();
});

test("offline create on A becomes visible on B after A reconnects", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("Offline peer");

  await contextA.setOffline(true);
  await createNote(pageA, title, "offline body");
  await expectNoteVisible(pageA, title);

  await contextA.setOffline(false);
  // Outbox retries on online; Sync also pulls — give A a nudge to flush/pull.
  await syncNow(pageA);
  await expect
    .poll(async () => {
      const res = await fetch("http://127.0.0.1:8787/test/stats");
      const stats = (await res.json()) as { entries: number };
      return stats.entries;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);

  await syncNow(pageB);
  await expectNoteVisible(pageB, title);
  await expect(pageB.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});
