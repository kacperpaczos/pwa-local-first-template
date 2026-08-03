import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const RELAY_CTRL = "http://127.0.0.1:8787";

export async function resetRelay(): Promise<void> {
  const res = await fetch(`${RELAY_CTRL}/test/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`relay reset failed: ${res.status} ${await res.text()}`);
  }
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

export async function expectNoteVisible(page: Page, title: string, timeout = 15_000): Promise<void> {
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
}> {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await waitForNotesReady(pageA);
  await waitForNotesReady(pageB);
  return { contextA, contextB, pageA, pageB };
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
    notes: { get: (id: string) => { id: string; body: string; title: string } | undefined };
  };
};

export async function getDb(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as { __db?: unknown }).__db), null, {
    timeout: 30_000,
  });
}

export async function updateNoteBodyViaDb(page: Page, noteId: string, body: string): Promise<string> {
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
