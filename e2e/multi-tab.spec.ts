import { expect, test } from "@playwright/test";
import {
  createNote,
  expectNoteHidden,
  expectNoteVisible,
  openTwoTabs,
  resetRelay,
  uniqueTitle,
} from "./helpers";

test.beforeEach(async () => {
  await resetRelay();
});

test("two tabs on the same origin share one OPFS database via the coordinator", async ({
  browser,
}) => {
  const { context, tabA, tabB } = await openTwoTabs(browser);

  const title = uniqueTitle("Multi-tab note");
  await createNote(tabA, title);
  await expectNoteVisible(tabA, title);
  await expectNoteVisible(tabB, title);

  await context.close();
});

test("soft-delete on tab A removes the note from the active list on tab B", async ({ browser }) => {
  const { context, tabA, tabB } = await openTwoTabs(browser);

  const title = uniqueTitle("Multi-tab delete");
  await createNote(tabA, title);
  await expectNoteVisible(tabB, title);

  await tabA.getByTestId("note-item").filter({ hasText: title }).getByTestId("note-delete").click();
  await expectNoteHidden(tabA, title);
  await expectNoteHidden(tabB, title);

  await tabB.getByTestId("filter-all").click();
  await expect(tabB.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await context.close();
});
