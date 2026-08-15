import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import SEA from "gun/sea.js";
import { exportSpaceKey, generateSpaceKey } from "../src/shared/crypto/envelope";
import { SPACE_ID_STORAGE_KEY, SPACE_KEY_STORAGE_KEY } from "../src/shared/identity/space";
import {
  IDENTITY_STORAGE_KEY,
  type IdentityPayload,
  type SeaPair,
} from "../src/shared/identity/types";

// Port comes from the Playwright config (via scripts/e2e.mjs); 8765 is the
// documented default when the suite is run without the wrapper.
export const GUN_PEER_CTRL = `http://127.0.0.1:${process.env.GUN_PEER_PORT ?? "8765"}`;

export async function resetGunPeer(): Promise<void> {
  const res = await fetch(`${GUN_PEER_CTRL}/test/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`gun peer reset failed: ${res.status} ${await res.text()}`);
  }
}

export type TestSpace = {
  spaceId: string;
  spaceKeyB64: string;
};

export async function generateTestIdentity(): Promise<IdentityPayload> {
  const pair = (await SEA.pair()) as SeaPair;
  return { v: 1, pair };
}

export async function generateTestSpace(): Promise<TestSpace> {
  const key = await generateSpaceKey();
  return {
    spaceId: crypto.randomUUID(),
    spaceKeyB64: await exportSpaceKey(key),
  };
}

async function injectIdentity(
  context: BrowserContext,
  identity: IdentityPayload,
  space?: TestSpace,
): Promise<void> {
  await context.addInitScript(
    ({ identityKey, identityPayload, spaceIdKey, spaceKeyKey, spaceId, spaceKeyB64 }) => {
      localStorage.setItem(identityKey, identityPayload);
      if (spaceId && spaceKeyB64) {
        localStorage.setItem(spaceIdKey, spaceId);
        localStorage.setItem(spaceKeyKey, spaceKeyB64);
      }
    },
    {
      identityKey: IDENTITY_STORAGE_KEY,
      identityPayload: JSON.stringify(identity),
      spaceIdKey: SPACE_ID_STORAGE_KEY,
      spaceKeyKey: SPACE_KEY_STORAGE_KEY,
      spaceId: space?.spaceId ?? null,
      spaceKeyB64: space?.spaceKeyB64 ?? null,
    },
  );
}

export async function waitForCounterReady(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("counter-value")).toBeVisible({ timeout: 30_000 });
}

export async function readCounterValue(page: Page): Promise<number> {
  const text = await page.getByTestId("counter-value").textContent();
  return Number(text?.trim() ?? "NaN");
}

export async function clickIncrement(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.getByTestId("counter-increment").click();
  }
}

export async function saveLabel(page: Page, label: string): Promise<void> {
  await page.getByTestId("counter-label").fill(label);
  await page.getByTestId("counter-label-save").click();
}

export async function expectCounterValue(
  page: Page,
  value: number,
  timeout = 15_000,
): Promise<void> {
  await expect(page.getByTestId("counter-value")).toHaveText(String(value), { timeout });
}

export async function expectLabel(page: Page, label: string, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId("counter-label")).toHaveValue(label, { timeout });
}

export async function syncNow(page: Page): Promise<void> {
  await page.getByTestId("sync-now").click();
}

export async function openTwoPeers(browser: Browser): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  pageA: Page;
  pageB: Page;
  identity: IdentityPayload;
  space: TestSpace;
}> {
  const identity = await generateTestIdentity();
  const space = await generateTestSpace();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await injectIdentity(contextA, identity, space);
  await injectIdentity(contextB, identity, space);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await waitForCounterReady(pageA);
  await waitForCounterReady(pageB);
  return { contextA, contextB, pageA, pageB, identity, space };
}

export async function openTwoTabs(browser: Browser): Promise<{
  context: BrowserContext;
  tabA: Page;
  tabB: Page;
}> {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await waitForCounterReady(tabA);
  await waitForCounterReady(tabB);
  return { context, tabA, tabB };
}

type DbHarness = {
  db: {
    entity: string;
    store: {
      unpublished: (entity: string) => Array<{ hash: string }>;
    };
  };
};

export async function getDb(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as { __db?: unknown }).__db), null, {
    timeout: 30_000,
  });
}

/**
 * Polls until every op this device appended has actually been published to
 * the relay. Needed before asserting on another device (or reloading): the
 * facade publishes in the background, so a click can be locally folded while
 * its op is still queued in the log/outbox.
 */
export async function waitForPublished(page: Page, timeout = 30_000): Promise<void> {
  await getDb(page);
  await page.evaluate(
    async ({ timeoutMs }) => {
      const harness = (globalThis as unknown as { __db: DbHarness }).__db;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (harness.db.store.unpublished(harness.db.entity).length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Ops never finished publishing");
    },
    { timeoutMs: timeout },
  );
}
