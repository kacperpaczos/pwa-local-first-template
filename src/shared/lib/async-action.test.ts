import { describe, expect, it } from "vitest";
import { createAsyncAction } from "./async-action";

describe("createAsyncAction", () => {
  it("clears the error, sets busy around the call, and busy false on success", async () => {
    const busyStates: boolean[] = [];
    const errors: (string | null)[] = [];
    const run = createAsyncAction(
      (b) => busyStates.push(b),
      (e) => errors.push(e),
      async () => {
        expect(busyStates).toEqual([true]);
      },
    );

    await run();

    expect(errors).toEqual([null]);
    expect(busyStates).toEqual([true, false]);
  });

  it("formats a thrown error and still clears busy", async () => {
    const busyStates: boolean[] = [];
    const errors: (string | null)[] = [];
    const run = createAsyncAction(
      (b) => busyStates.push(b),
      (e) => errors.push(e),
      async () => {
        throw new Error("boom");
      },
    );

    await run();

    expect(errors).toEqual([null, "boom"]);
    expect(busyStates).toEqual([true, false]);
  });

  it("uses a custom formatError", async () => {
    const errors: (string | null)[] = [];
    const run = createAsyncAction(
      () => {},
      (e) => errors.push(e),
      async () => {
        throw new Error("raw");
      },
      () => "friendly message",
    );

    await run();

    expect(errors).toEqual([null, "friendly message"]);
  });

  it("forwards arguments to the wrapped function", async () => {
    const seen: unknown[] = [];
    const run = createAsyncAction<[string, number]>(
      () => {},
      () => {},
      async (a, b) => {
        seen.push(a, b);
      },
    );

    await run("x", 42);

    expect(seen).toEqual(["x", 42]);
  });
});
