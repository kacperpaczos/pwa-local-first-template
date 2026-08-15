import { expect, test } from "@playwright/test";
import {
  createNote,
  expectNoteVisible,
  openTwoPeers,
  resetGunPeer,
  syncNow,
  uniqueTitle,
  waitForNoteSynced,
} from "./helpers";

test.beforeEach(async () => {
  await resetGunPeer();
});

test("offline create on A becomes visible on B after A reconnects", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("Offline peer");

  await contextA.setOffline(true);
  await createNote(pageA, title, "offline body");
  await expectNoteVisible(pageA, title);

  await contextA.setOffline(false);
  // Outbox retries on online; wait for this note's own push cycle (not relay stats).
  await syncNow(pageA);
  await waitForNoteSynced(pageA, title);

  await syncNow(pageB);
  await expectNoteVisible(pageB, title);
  await expect(pageB.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});
