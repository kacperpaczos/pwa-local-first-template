import { test } from "@playwright/test";
import {
  clickIncrement,
  expectCounterValue,
  expectLabel,
  openTwoTabs,
  resetGunPeer,
  saveLabel,
} from "./helpers";

test.beforeEach(async () => {
  await resetGunPeer();
});

test("two tabs on the same origin share one database — increments from both tabs sum", async ({
  browser,
}) => {
  const { context, tabA, tabB } = await openTwoTabs(browser);

  await clickIncrement(tabA, 1);
  await clickIncrement(tabB, 1);

  // No relay round-trip involved: both tabs append to the SAME device log
  // over the same OPFS database, and the shared total is 2 — not two
  // divergent 1s, and not 3.
  await expectCounterValue(tabA, 2, 30_000);
  await expectCounterValue(tabB, 2, 30_000);

  await context.close();
});

test("a label saved in tab A shows up in tab B", async ({ browser }) => {
  const { context, tabA, tabB } = await openTwoTabs(browser);

  await saveLabel(tabA, "from tab A");
  await expectLabel(tabB, "from tab A", 30_000);

  await context.close();
});
