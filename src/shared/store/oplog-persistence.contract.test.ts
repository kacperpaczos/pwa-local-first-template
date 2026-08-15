import { MemoryOpLogPersistence } from "./oplog-persistence";
import { describeOpLogPersistenceContract } from "./oplog-persistence.contract";

describeOpLogPersistenceContract("MemoryOpLogPersistence", () => ({
  persistence: new MemoryOpLogPersistence(),
}));
