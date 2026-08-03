import { describe, expect, it } from "vitest";
import { getEntitySchema, registerEntitySchema } from "./entity-registry";

describe("entity registry", () => {
  it("round-trips a registered schema", () => {
    const schema = { parse: (data: unknown) => data };
    registerEntitySchema("widget", schema);

    expect(getEntitySchema("widget")).toBe(schema);
  });

  it("returns undefined for an unregistered entity", () => {
    expect(getEntitySchema("gizmo")).toBeUndefined();
  });

  it("throws when registering the same entity twice", () => {
    registerEntitySchema("gadget", { parse: (data: unknown) => data });

    expect(() =>
      registerEntitySchema("gadget", { parse: (data: unknown) => data }),
    ).toThrow(/already registered/);
  });
});
