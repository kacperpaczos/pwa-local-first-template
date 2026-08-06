import SEA from "gun/sea";
import { parseJsonOrThrow } from "@/shared/lib/json";
import {
  IDENTITY_STORAGE_KEY,
  type IdentityPayload,
  type SeaPair,
} from "./types";

function isSeaPair(value: unknown): value is SeaPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Record<string, unknown>;
  return (
    typeof pair.pub === "string" &&
    typeof pair.priv === "string" &&
    typeof pair.epub === "string" &&
    typeof pair.epriv === "string" &&
    pair.pub.length > 0 &&
    pair.priv.length > 0
  );
}

export function parseIdentityPayload(raw: unknown): IdentityPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid identity payload");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1 || !isSeaPair(obj.pair)) {
    throw new Error("Unsupported or invalid identity payload");
  }
  return { v: 1, pair: obj.pair };
}

export function parseIdentityJson(text: string): IdentityPayload {
  return parseIdentityPayload(parseJsonOrThrow(text, "Identity JSON is not valid"));
}

export function loadStoredPair(
  storage: Pick<Storage, "getItem"> = localStorage,
): SeaPair | null {
  const raw = storage.getItem(IDENTITY_STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseIdentityJson(raw).pair;
  } catch {
    return null;
  }
}

export function savePair(
  pair: SeaPair,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  const payload: IdentityPayload = { v: 1, pair };
  storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(payload));
}

export function clearStoredPair(
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  storage.removeItem(IDENTITY_STORAGE_KEY);
}

export async function generatePair(): Promise<SeaPair> {
  const pair = await SEA.pair();
  if (!isSeaPair(pair)) {
    throw new Error("SEA.pair returned an incomplete key pair");
  }
  return pair;
}

/** Load existing pair or create + persist a new one. */
export async function ensurePair(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<SeaPair> {
  const existing = loadStoredPair(storage);
  if (existing) return existing;
  const pair = await generatePair();
  savePair(pair, storage);
  return pair;
}

export function exportIdentityPayload(pair: SeaPair): IdentityPayload {
  return { v: 1, pair };
}

export function exportIdentityJson(pair: SeaPair): string {
  return JSON.stringify(exportIdentityPayload(pair));
}

export function importIdentityJson(
  text: string,
  storage: Pick<Storage, "setItem"> = localStorage,
): SeaPair {
  const payload = parseIdentityJson(text);
  savePair(payload.pair, storage);
  return payload.pair;
}
