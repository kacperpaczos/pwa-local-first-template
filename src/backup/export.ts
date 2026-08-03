import * as z from "zod/mini";
import type { Collection } from "@tanstack/db";
import { noteSchema, type Note } from "@/shared/db/schemas";

export const BACKUP_FORMAT_VERSION = 1;

export const backupSchema = z.object({
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: z.string(),
  notes: z.array(noteSchema),
});

export type Backup = z.infer<typeof backupSchema>;

/**
 * Snapshots every row (including soft-deleted ones — tombstones matter for
 * consistency once this file is imported on another device). Each note is
 * re-validated through `noteSchema` so a malformed in-memory row can never
 * cross the serialization boundary silently.
 */
export function exportNotesAsBackup(notes: Collection<Note, string>): Backup {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    notes: notes.toArray.map((note) => noteSchema.parse(note)),
  };
}

export function serializeBackup(backup: Backup): string {
  return JSON.stringify(backup, null, 2);
}

export function backupFileName(at: Date = new Date()): string {
  return `pwa-local-first-backup-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Browser-only: triggers a file download for the serialized backup. */
export function downloadBackupFile(backup: Backup): void {
  if (typeof document === "undefined") {
    throw new Error("downloadBackupFile requires a browser environment");
  }
  const blob = new Blob([serializeBackup(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = backupFileName(new Date(backup.exportedAt));
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
