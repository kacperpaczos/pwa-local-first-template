import { describe, expect, it } from "vitest";
import { createBodyDoc, mergeBodyDocs, updateBodyDoc } from "./crdt";

describe("crdt body docs", () => {
  it("createBodyDoc seeds text and a non-empty snapshot", () => {
    const created = createBodyDoc("hello");
    expect(created.text).toBe("hello");
    expect(created.doc.length).toBeGreaterThan(0);
  });

  it("createBodyDoc allows an empty body", () => {
    const created = createBodyDoc("");
    expect(created.text).toBe("");
    expect(created.doc.length).toBeGreaterThan(0);
  });

  it("updateBodyDoc rewrites the projection", () => {
    const base = createBodyDoc("Hello world");
    const updated = updateBodyDoc(base.doc, "Hello brave world");
    expect(updated.text).toBe("Hello brave world");
  });

  it("mergeBodyDocs merges concurrent edits from a shared ancestor", () => {
    const base = createBodyDoc("Hello world");
    const a = updateBodyDoc(base.doc, "Hello brave world");
    const b = updateBodyDoc(base.doc, "Hello world!");
    const merged = mergeBodyDocs(a.doc, b.doc);
    expect(merged.text).toBe("Hello brave world!");
  });

  it("mergeBodyDocs works when local snapshot is null", () => {
    const remote = createBodyDoc("only remote");
    const merged = mergeBodyDocs(null, remote.doc);
    expect(merged.text).toBe("only remote");
  });

  it("re-importing the same remote snapshot is idempotent", () => {
    const base = createBodyDoc("x");
    const once = mergeBodyDocs(base.doc, base.doc);
    const twice = mergeBodyDocs(once.doc, base.doc);
    expect(twice.text).toBe(once.text);
    expect(twice.doc).toBe(once.doc);
  });
});
