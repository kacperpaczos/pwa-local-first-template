import { v7 as uuidv7 } from "uuid";

/** Sortable, collision-resistant primary keys for multi-peer local-first data. */
export function createEntityId(): string {
  return uuidv7();
}

export function isEntityId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
