import { expect, test } from "@playwright/test";
import {
  createNote,
  expectNoteHidden,
  expectNoteVisible,
  openTwoPeers,
  resetRelay,
  syncNow,
  uniqueTitle,
} from "./helpers";

test.beforeEach(async () => {
  await resetRelay();
});

test("create on A appears on B after Sync", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("Relay note");
  await createNote(pageA, title);
  await expectNoteVisible(pageA, title);

  await syncNow(pageB);
  await expectNoteVisible(pageB, title);

  await contextA.close();
  await contextB.close();
});

test("soft-delete on A syncs to B; tombstone visible under Wszystkie", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("Relay delete");
  await createNote(pageA, title);
  await syncNow(pageB);
  await expectNoteVisible(pageB, title);

  await pageA.getByTestId("note-item").filter({ hasText: title }).getByTestId("note-delete").click();
  await expectNoteHidden(pageA, title);

  await syncNow(pageB);
  await expectNoteHidden(pageB, title);

  await pageB.getByTestId("filter-all").click();
  await expect(pageB.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});

test("idempotent Sync on B does not duplicate the note", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("Relay idempotent");
  await createNote(pageA, title);
  await syncNow(pageB);
  await expectNoteVisible(pageB, title);

  await syncNow(pageB);
  await syncNow(pageB);
  await expect(pageB.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});
