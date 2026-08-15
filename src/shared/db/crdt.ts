import { LoroDoc } from "loro-crdt";
import { base64ToBytes, bytesToBase64 } from "@/shared/crypto/bytes";

const BODY_KEY = "body";

export type BodyMergeResult = {
  text: string;
  doc: string;
};

function encodeSnapshot(doc: LoroDoc): string {
  return bytesToBase64(doc.export({ mode: "snapshot" }));
}

function decodeSnapshot(base64: string): LoroDoc {
  const doc = new LoroDoc();
  doc.import(base64ToBytes(base64));
  return doc;
}

/** New note: seed a fresh CRDT text doc with the initial body. */
export function createBodyDoc(initialText: string): BodyMergeResult {
  const doc = new LoroDoc();
  if (initialText.length > 0) {
    doc.getText(BODY_KEY).insert(0, initialText);
  }
  return { text: initialText, doc: encodeSnapshot(doc) };
}

/**
 * Local edit: rewrite the text container to match the new full string.
 * `LoroText.update` diffs against the previous content, so only the actual
 * delta becomes a causal operation attributed to this peer.
 */
export function updateBodyDoc(existingDocB64: string, newText: string): BodyMergeResult {
  const doc = decodeSnapshot(existingDocB64);
  doc.getText(BODY_KEY).update(newText);
  return { text: doc.getText(BODY_KEY).toString(), doc: encodeSnapshot(doc) };
}

/**
 * Remote merge: import the remote peer's CRDT history into a copy of the
 * local doc. Concurrent edits to the same body resolve without a
 * local/remote "winner" — this is the escalation path from per-field LWW
 * to real CRDT merging for free-text content.
 */
export function mergeBodyDocs(localDocB64: string | null, remoteDocB64: string): BodyMergeResult {
  const doc = localDocB64 ? decodeSnapshot(localDocB64) : new LoroDoc();
  doc.import(base64ToBytes(remoteDocB64));
  return { text: doc.getText(BODY_KEY).toString(), doc: encodeSnapshot(doc) };
}
