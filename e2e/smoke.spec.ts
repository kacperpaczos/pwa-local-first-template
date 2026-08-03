import { expect, test } from "@playwright/test";
import { createNote, uniqueTitle, waitForNotesReady } from "./helpers";

test("home redirects user toward notes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "pwa-local-first-template",
  );
  await page.getByRole("link", { name: "Open notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
});

test("notes CRUD soft-delete flow", async ({ page }) => {
  await waitForNotesReady(page);

  const title = uniqueTitle("E2E note");
  await createNote(page, title, "Treść testowa");
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1);

  const primary = page.getByTestId("note-item").filter({ hasText: title });
  await primary.getByTestId("note-delete").click();
  await expect(primary).toHaveCount(0);
});
