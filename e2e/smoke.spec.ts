import { expect, test } from "@playwright/test";
import {
  clickIncrement,
  expectCounterValue,
  expectLabel,
  saveLabel,
  waitForCounterReady,
  waitForPublished,
} from "./helpers";

test("the counter renders and increments locally", async ({ page }) => {
  await waitForCounterReady(page);
  await expectCounterValue(page, 0);

  await clickIncrement(page, 3);
  await expectCounterValue(page, 3);
});

test("value and label survive a reload (OPFS persistence)", async ({ page }) => {
  await waitForCounterReady(page);

  await clickIncrement(page, 2);
  await saveLabel(page, "smoke label");
  await expectCounterValue(page, 2);
  await waitForPublished(page);

  await page.reload();
  await waitForCounterReady(page);
  await expectCounterValue(page, 2);
  await expectLabel(page, "smoke label");
});

test("settings page renders its sections", async ({ page }) => {
  await waitForCounterReady(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("storage-persist-status")).toBeVisible();
});
