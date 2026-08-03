import { expect, test } from "@playwright/test";
import {
  createNote,
  expectNoteVisible,
  findNoteIdByTitle,
  openTwoPeers,
  readNoteBodyViaDb,
  resetRelay,
  syncNow,
  uniqueTitle,
  updateNoteBodyViaDb,
} from "./helpers";

test.beforeEach(async () => {
  await resetRelay();
});

test("concurrent body edits merge via Loro CRDT across peers", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  const title = uniqueTitle("CRDT merge");
  await createNote(pageA, title, "Hello world");
  await expectNoteVisible(pageA, title);

  await syncNow(pageB);
  await expectNoteVisible(pageB, title);

  const noteIdA = await findNoteIdByTitle(pageA, title);
  const noteIdB = await findNoteIdByTitle(pageB, title);
  expect(noteIdA).toBe(noteIdB);

  // Concurrent edits from the same base — no intervening pull of the peer's edit.
  await updateNoteBodyViaDb(pageA, noteIdA, "Hello brave world");
  await updateNoteBodyViaDb(pageB, noteIdB, "Hello world!");

  await syncNow(pageA);
  await syncNow(pageB);
  await syncNow(pageA);

  await expect
    .poll(async () => readNoteBodyViaDb(pageA, noteIdA), { timeout: 15_000 })
    .toBe("Hello brave world!");
  await expect
    .poll(async () => readNoteBodyViaDb(pageB, noteIdB), { timeout: 15_000 })
    .toBe("Hello brave world!");

  await contextA.close();
  await contextB.close();
});
