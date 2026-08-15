import { describe, expect, it, beforeEach } from "vitest";
import { createEntityId, isEntityId } from "./ids";
import { nextLamport, peekLamport, resetLamportForTests } from "./lamport";
import { COUNTER_ID, emptyCounter, parseCounter } from "./schemas";

describe("createEntityId", () => {
  it("returns UUIDv7-shaped ids", () => {
    const id = createEntityId();
    expect(isEntityId(id)).toBe(true);
  });
});

describe("lamport", () => {
  beforeEach(() => {
    resetLamportForTests(0);
  });

  it("increments monotonically and respects remote hints", () => {
    expect(nextLamport()).toBe(1);
    expect(nextLamport()).toBe(2);
    expect(nextLamport(10)).toBe(11);
    expect(peekLamport()).toBe(11);
  });
});

describe("schemas", () => {
  it("parses the counter state row", () => {
    const counter = parseCounter({ id: COUNTER_ID, value: 3, label: "demo", label_lamport: 2 });
    expect(counter.value).toBe(3);
  });

  it("rejects a negative or non-integer value", () => {
    expect(() =>
      parseCounter({ id: COUNTER_ID, value: -1, label: "", label_lamport: 0 }),
    ).toThrow();
    expect(() =>
      parseCounter({ id: COUNTER_ID, value: 1.5, label: "", label_lamport: 0 }),
    ).toThrow();
  });

  it("emptyCounter starts at zero with an empty label", () => {
    expect(emptyCounter()).toEqual({ id: COUNTER_ID, value: 0, label: "", label_lamport: 0 });
  });
});
