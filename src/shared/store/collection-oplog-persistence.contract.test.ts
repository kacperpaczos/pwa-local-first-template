import { describe, it } from "vitest";
import {
  createNodeSqliteCollections,
  nodeSqliteAvailable,
} from "@/testing/harness/node-sqlite-collections";
import { CollectionOpLogPersistence } from "./collection-oplog-persistence";
import type { HeadRow, StoredOp } from "./oplog-persistence";
import { describeOpLogPersistenceContract } from "./oplog-persistence.contract";

/**
 * The shipping implementation, over real TanStack persisted collections and a
 * real SQLite database (node:sqlite instead of wa-sqlite/OPFS). Everything
 * above the driver is the production stack.
 */
if (nodeSqliteAvailable) {
  describeOpLogPersistenceContract("CollectionOpLogPersistence (node:sqlite)", () => {
    const sqlite = createNodeSqliteCollections();
    const ops = sqlite.collection<StoredOp, string>("oplog_ops", (row) => row.hash);
    const heads = sqlite.collection<HeadRow, string>("oplog_heads", (row) => row.id);
    return {
      persistence: new CollectionOpLogPersistence(ops, heads),
      cleanup: () => sqlite.close(),
    };
  });
} else {
  // Visible skip rather than silent absence — a green run must never imply
  // this implementation was covered when it was not.
  describe("OpLogPersistence contract: CollectionOpLogPersistence (node:sqlite)", () => {
    it.skip("requires Node >= 23.4 for unflagged node:sqlite", () => {});
  });
}
