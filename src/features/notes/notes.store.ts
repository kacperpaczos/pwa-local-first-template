import { atom } from "nanostores";

export type NotesFilter = "active" | "all";

export const notesFilterStore = atom<NotesFilter>("active");
export const syncStatusStore = atom<"idle" | "syncing" | "offline">("idle");
export const notesFormErrorStore = atom<string | null>(null);

export function setNotesFilter(filter: NotesFilter): void {
  notesFilterStore.set(filter);
}

export function setSyncStatus(status: "idle" | "syncing" | "offline"): void {
  syncStatusStore.set(status);
}

export function setNotesFormError(message: string | null): void {
  notesFormErrorStore.set(message);
}
