import { afterEach, describe, expect, it } from "vitest";
import { nextLamport, peekLamport, resetLamportForTests, seedLamportFromState } from "./lamport";

describe("lamport clock", () => {
  afterEach(() => {
    resetLamportForTests(0);
  });

  it("is monotonic across successive local calls", () => {
    expect(nextLamport()).toBe(1);
    expect(nextLamport()).toBe(2);
    expect(nextLamport()).toBe(3);
  });

  it("jumps ahead of a higher remote hint, then keeps incrementing from there", () => {
    nextLamport();
    expect(nextLamport(10)).toBe(11);
    expect(nextLamport()).toBe(12);
  });

  it("ignores a remote hint lower than the current clock", () => {
    resetLamportForTests(5);
    expect(nextLamport(1)).toBe(6);
  });

  it("peekLamport reflects the clock without advancing it", () => {
    nextLamport();
    nextLamport();
    expect(peekLamport()).toBe(2);
    expect(peekLamport()).toBe(2);
  });

  describe("seedLamportFromState", () => {
    it("raises the clock to the max label lamport across rows", () => {
      seedLamportFromState([{ label_lamport: 3 }, { label_lamport: 7 }]);
      expect(peekLamport()).toBe(7);
      expect(nextLamport()).toBe(8);
    });

    it("never lowers an already-higher clock", () => {
      resetLamportForTests(20);
      seedLamportFromState([{ label_lamport: 3 }]);
      expect(peekLamport()).toBe(20);
    });

    it("is a no-op for an empty state set", () => {
      resetLamportForTests(4);
      seedLamportFromState([]);
      expect(peekLamport()).toBe(4);
    });
  });
});
