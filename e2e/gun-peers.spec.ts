import { test } from "@playwright/test";
import {
  clickIncrement,
  expectCounterValue,
  expectLabel,
  openTwoPeers,
  resetGunPeer,
  saveLabel,
  syncNow,
  waitForPublished,
} from "./helpers";

test.beforeEach(async () => {
  await resetGunPeer();
});

test("an increment on A appears on B after Sync", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  await clickIncrement(pageA, 2);
  await expectCounterValue(pageA, 2);
  await waitForPublished(pageA);

  await syncNow(pageB);
  await expectCounterValue(pageB, 2, 30_000);

  await contextA.close();
  await contextB.close();
});

test("concurrent increments on A and B SUM — nobody's click is lost", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  // Both devices click before either has synced the other's ops.
  await clickIncrement(pageA, 2);
  await clickIncrement(pageB, 3);
  await waitForPublished(pageA);
  await waitForPublished(pageB);

  await syncNow(pageA);
  await syncNow(pageB);
  await expectCounterValue(pageA, 5, 30_000);
  await expectCounterValue(pageB, 5, 30_000);

  await contextA.close();
  await contextB.close();
});

test("repeated Sync is idempotent — the total never inflates", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  await clickIncrement(pageA, 3);
  await waitForPublished(pageA);
  await syncNow(pageB);
  await expectCounterValue(pageB, 3, 30_000);

  await syncNow(pageB);
  await syncNow(pageB);
  await expectCounterValue(pageB, 3);

  await contextA.close();
  await contextB.close();
});

test("a label set on A wins deterministically on both devices", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  await saveLabel(pageA, "shared counter");
  await waitForPublished(pageA);

  await syncNow(pageB);
  await expectLabel(pageB, "shared counter", 30_000);

  await contextA.close();
  await contextB.close();
});
