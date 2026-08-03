import { beforeEach, describe, expect, it } from "vitest";
import {
  aiStatusStore,
  setAiAvailable,
  setAiBusy,
  setAiDownloading,
  setAiError,
  setAiReady,
  setAiUnavailable,
} from "./status";
import { parseSuggestedMeta } from "./types";

describe("ai status machine", () => {
  beforeEach(() => {
    setAiUnavailable("disabled");
  });

  it("transitions unavailable → available → downloading → ready → busy", () => {
    expect(aiStatusStore.get()).toEqual({ kind: "unavailable", reason: "disabled" });
    setAiAvailable();
    expect(aiStatusStore.get()).toEqual({ kind: "available" });
    setAiDownloading(0.4);
    expect(aiStatusStore.get()).toEqual({ kind: "downloading", progress: 0.4 });
    setAiReady();
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
    setAiBusy();
    expect(aiStatusStore.get()).toEqual({ kind: "busy" });
  });

  it("can report errors from any ready-ish state", () => {
    setAiAvailable();
    setAiError("oom");
    expect(aiStatusStore.get()).toEqual({ kind: "error", reason: "oom" });
  });

  it("can mark unavailable for no-webgpu", () => {
    setAiUnavailable("no-webgpu");
    expect(aiStatusStore.get()).toEqual({ kind: "unavailable", reason: "no-webgpu" });
  });
});

describe("parseSuggestedMeta", () => {
  it("accepts a valid payload", () => {
    expect(parseSuggestedMeta({ title: "T", tags: ["a"] })).toEqual({
      title: "T",
      tags: ["a"],
    });
  });

  it("rejects empty title or too many tags", () => {
    expect(() => parseSuggestedMeta({ title: "", tags: [] })).toThrow();
    expect(() =>
      parseSuggestedMeta({
        title: "ok",
        tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      }),
    ).toThrow();
  });
});
