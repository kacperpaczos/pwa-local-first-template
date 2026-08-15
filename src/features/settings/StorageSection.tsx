import type { Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { storagePersistStore } from "@/shared/db/storage-persist";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function persistLabel(status: ReturnType<typeof storagePersistStore.get>): string {
  switch (status) {
    case "persisted":
      return "Your data is protected from automatic cleanup.";
    case "not-persisted":
      return "The browser may clear data if storage runs low. Keep backups.";
    case "unsupported":
      return "This browser does not support persistent storage — keep backups.";
    case "unknown":
      return "Persistence status unknown (nothing saved yet).";
  }
}

const StorageSection: Component = () => {
  const persistStatus = useStore(storagePersistStore);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data persistence</CardTitle>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground" data-testid="storage-persist-status">
          {persistLabel(persistStatus())}
        </p>
      </CardContent>
    </Card>
  );
};

export default StorageSection;
