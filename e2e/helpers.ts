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

/** @deprecated Use resetGunPeer */
export const resetRelay = resetGunPeer;

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

export async function waitForNotesReady(page: Page): Promise<void> {
  await page.goto("/notes");
  await expect(page.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("notes-empty").or(page.getByTestId("notes-list"))).toBeVisible({
    timeout: 30_000,
  });
}

export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createNote(page: Page, title: string, body = ""): Promise<void> {
  await page.getByTestId("note-title").fill(title);
  if (body) {
    await page.getByTestId("note-body").fill(body);
  }
  await page.getByTestId("note-submit").click();
}

export async function expectNoteVisible(
  page: Page,
  title: string,
  timeout = 15_000,
): Promise<void> {
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toHaveCount(1, {
    timeout,
  });
}

export async function expectNoteHidden(page: Page, title: string, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId("note-item").filter({ hasText: title })).toHaveCount(0, {
    timeout,
  });
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
  await waitForNotesReady(pageA);
  await waitForNotesReady(pageB);
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
  await waitForNotesReady(tabA);
  await waitForNotesReady(tabB);
  return { context, tabA, tabB };
}

type DbHarness = {
  facade: {
    createNote: (input: { title: string; body?: string }) => Promise<{ id: string; body: string }>;
    updateNote: (
      id: string,
      input: { title?: string; body?: string },
    ) => Promise<{ id: string; body: string }>;
    softDeleteNote: (id: string) => Promise<{ id: string }>;
  };
  db: {
    notes: {
      get: (id: string) => { id: string; body: string; title: string } | undefined;
      toArray: Array<{ id: string; title: string; $synced?: boolean }>;
    };
  };
};

/**
 * Polls the collection until this note's own sync cycle finished ($synced).
 * Needed before full page navigation: a reload's pullRemote() can otherwise
 * race a not-yet-pushed local write.
 */
export async function waitForNoteSynced(
  page: Page,
  title: string,
  timeout = 30_000,
): Promise<string> {
  await getDb(page);
  return page.evaluate(
    async ({ noteTitle, timeoutMs }) => {
      const harness = (globalThis as unknown as { __db: DbHarness }).__db;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = harness.db.notes.toArray.find((n) => n.title === noteTitle);
        if (found?.$synced) return found.id;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Note never reached $synced=true: ${noteTitle}`);
    },
    { noteTitle: title, timeoutMs: timeout },
  );
}

export async function getDb(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as { __db?: unknown }).__db), null, {
    timeout: 30_000,
  });
}

export async function updateNoteBodyViaDb(
  page: Page,
  noteId: string,
  body: string,
): Promise<string> {
  await getDb(page);
  return page.evaluate(
    async ({ id, nextBody }) => {
      const harness = (globalThis as unknown as { __db: DbHarness }).__db;
      const updated = await harness.facade.updateNote(id, { body: nextBody });
      return updated.body;
    },
    { id: noteId, nextBody: body },
  );
}

export async function findNoteIdByTitle(page: Page, title: string): Promise<string> {
  await getDb(page);
  return page.evaluate((noteTitle) => {
    const harness = (globalThis as unknown as { __db: DbHarness }).__db;
    const notes = harness.db.notes as unknown as {
      toArray?: Array<{ id: string; title: string }> | (() => Array<{ id: string; title: string }>);
    };
    const raw = notes.toArray;
    const rows = typeof raw === "function" ? raw() : (raw ?? []);
    const found = rows.find((n) => n.title === noteTitle);
    if (!found) {
      throw new Error(`Note not found in __db: ${noteTitle}`);
    }
    return found.id;
  }, title);
}

export async function readNoteBodyViaDb(page: Page, noteId: string): Promise<string> {
  await getDb(page);
  return page.evaluate((id) => {
    const harness = (globalThis as unknown as { __db: DbHarness }).__db;
    const note = harness.db.notes.get(id);
    if (!note) {
      throw new Error(`Note missing: ${id}`);
    }
    return note.body;
  }, noteId);
}
