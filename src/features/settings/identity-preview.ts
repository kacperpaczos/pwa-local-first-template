import { atom } from "nanostores";
import { loadSpaceId, loadStoredPair } from "@/shared/identity";

/**
 * Small shared display state for "what identity/space is this device
 * currently in" — read by PairingSection, written by both PairingSection
 * (on pair/import) and RecoverySection (restoring a space key also changes
 * which space this device reports). A nanostore keeps the two sections
 * decoupled without prop-drilling through SettingsPage.
 */
export const pubPreviewStore = atom<string | null>(loadStoredPair()?.pub ?? null);
export const spacePreviewStore = atom<string | null>(loadSpaceId());

export function setPubPreview(pub: string | null): void {
  pubPreviewStore.set(pub);
}

export function setSpacePreview(spaceId: string | null): void {
  spacePreviewStore.set(spaceId);
}
