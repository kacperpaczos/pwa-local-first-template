import { test } from "@playwright/test";
import {
  clickIncrement,
  expectCounterValue,
  openTwoPeers,
  resetGunPeer,
  syncNow,
  waitForPublished,
} from "./helpers";

test.beforeEach(async () => {
  await resetGunPeer();
});

test("offline increments on A become visible on B after A reconnects", async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await openTwoPeers(browser);

  await contextA.setOffline(true);
  await clickIncrement(pageA, 3);
  // Fully functional offline: the local fold lands with no relay reachable.
  await expectCounterValue(pageA, 3);

  await contextA.setOffline(false);
  // The log is the outbox — reconnect + a cycle publishes the queued ops.
  await syncNow(pageA);
  await waitForPublished(pageA);

  await syncNow(pageB);
  await expectCounterValue(pageB, 3, 30_000);

  await contextA.close();
  await contextB.close();
});
