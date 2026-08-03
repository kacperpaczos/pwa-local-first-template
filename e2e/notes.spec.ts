import { expect, test } from "@playwright/test";

test("home redirects user toward notes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "pwa-local-first-template",
  );
  await page.getByRole("link", { name: "Otwórz notatki" }).click();
  await expect(page).toHaveURL(/\/notes$/);
});

test("notes CRUD soft-delete flow", async ({ page }) => {
  await page.goto("/notes");
  await expect(page.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("notes-empty").or(page.getByTestId("notes-list"))).toBeVisible();

  const title = `E2E note ${Date.now()}`;
  const offlineTitle = `E2E offline ${Date.now()}`;

  await page.getByTestId("note-title").fill(title);
  await page.getByTestId("note-body").fill("Treść testowa");
  await page.getByTestId("note-submit").click();
  await expect(page.getByTestId("notes-list")).toContainText(title);

  await page.context().setOffline(true);
  await page.getByTestId("note-title").fill(offlineTitle);
  await page.getByTestId("note-submit").click();
  await expect(page.getByTestId("notes-list")).toContainText(offlineTitle);
  await page.context().setOffline(false);

  const primary = page.getByTestId("note-item").filter({ hasText: title });
  await primary.getByTestId("note-delete").click();
  await expect(primary).toHaveCount(0);
  await expect(page.getByTestId("notes-list")).toContainText(offlineTitle);
});

test("two tabs on the same origin share one OPFS database via the coordinator", async ({
  browser,
}) => {
  // Same browser context = same origin storage, so both tabs open the *same*
  // OPFS-backed SQLite file. This exercises BrowserCollectionCoordinator's
  // leader election + BroadcastChannel fan-out directly, independent of the
  // WS relay (tabB never clicks "Synchronizuj" or goes through the relay).
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await tabA.goto("/notes");
  await tabB.goto("/notes");
  await expect(tabA.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  await expect(tabB.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });

  const title = `Multi-tab note ${Date.now()}`;
  await tabA.getByTestId("note-title").fill(title);
  await tabA.getByTestId("note-submit").click();
  await expect(tabA.getByTestId("notes-list")).toContainText(title);

  await expect(tabB.getByTestId("notes-list")).toContainText(title, { timeout: 15_000 });

  await context.close();
});

test("two peers sync a note through the websocket relay", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await pageA.goto("/notes");
  await pageB.goto("/notes");
  await expect(pageA.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });

  const title = `Relay note ${Date.now()}`;
  await pageA.getByTestId("note-title").fill(title);
  await pageA.getByTestId("note-submit").click();
  await expect(pageA.getByTestId("notes-list")).toContainText(title);

  await pageB.getByTestId("sync-now").click();
  await expect(pageB.getByTestId("notes-list")).toContainText(title, { timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});
