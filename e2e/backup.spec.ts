import { expect, test } from "@playwright/test";
import { createNote, resetRelay, uniqueTitle, waitForNoteSynced, waitForNotesReady } from "./helpers";

test.beforeEach(async () => {
  await resetRelay();
});

test("export on one device, import on a fresh device, data (incl. tombstones) matches", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await waitForNotesReady(pageA);

  const activeTitle = uniqueTitle("Backup active");
  const deletedTitle = uniqueTitle("Backup deleted");
  await createNote(pageA, activeTitle, "Body to restore");
  await waitForNoteSynced(pageA, activeTitle);
  await createNote(pageA, deletedTitle, "Will be a tombstone");
  await waitForNoteSynced(pageA, deletedTitle);
  await pageA
    .getByTestId("note-item")
    .filter({ hasText: deletedTitle })
    .getByTestId("note-delete")
    .click();
  await expect(pageA.getByTestId("note-item").filter({ hasText: deletedTitle })).toHaveCount(0);
  await waitForNoteSynced(pageA, deletedTitle);

  // In-app link, not page.goto() — goto() is a hard reload that would tear
  // down and re-open the whole DB (including a fresh, racy pullRemote()).
  await pageA.getByRole("link", { name: "Ustawienia" }).click();
  const downloadPromise = pageA.waitForEvent("download");
  await pageA.getByTestId("backup-export").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const backupJson = Buffer.concat(chunks).toString("utf-8");
  const exported = JSON.parse(backupJson) as { notes: Array<{ title: string; deleted_at: string | null }> };
  expect(exported.notes.length).toBeGreaterThanOrEqual(2);
  expect(exported.notes.find((n) => n.title === deletedTitle)?.deleted_at).not.toBeNull();

  // Fresh context = fresh OPFS, simulating a brand-new device.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await waitForNotesReady(pageB);
  await pageB.getByRole("link", { name: "Ustawienia" }).click();

  await pageB.getByTestId("backup-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(backupJson, "utf-8"),
  });
  await expect(pageB.getByTestId("backup-status")).toContainText("Zaimportowano");

  await pageB.getByRole("link", { name: "Wróć do notatek" }).click();
  await expect(pageB.getByTestId("note-item").filter({ hasText: activeTitle })).toHaveCount(1);
  await expect(
    pageB.getByTestId("note-item").filter({ hasText: activeTitle }),
  ).toContainText("Body to restore");
  await expect(pageB.getByTestId("note-item").filter({ hasText: deletedTitle })).toHaveCount(0);

  await pageB.getByTestId("filter-all").click();
  await expect(pageB.getByTestId("note-item").filter({ hasText: deletedTitle })).toHaveCount(1);
  await expect(
    pageB.getByTestId("note-item").filter({ hasText: deletedTitle }),
  ).toContainText("usunięta");

  await contextA.close();
  await contextB.close();
});

test("importing the same backup twice does not duplicate notes", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await waitForNotesReady(page);

  const title = uniqueTitle("Backup idempotent");
  await createNote(page, title, "once");
  await waitForNoteSynced(page, title);

  await page.getByRole("link", { name: "Ustawienia" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("backup-export").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const backupJson = Buffer.concat(chunks).toString("utf-8");

  const file = { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(backupJson, "utf-8") };
  await page.getByTestId("backup-import").setInputFiles(file);
  await expect(page.getByTestId("backup-status")).toContainText("Zaimportowano");
  await page.getByTestId("backup-import").setInputFiles(file);
  await expect(page.getByTestId("backup-status")).toContainText("Zaimportowano 0/1");

  await page.getByRole("link", { name: "Wróć do notatek" }).click();
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  await context.close();
});
