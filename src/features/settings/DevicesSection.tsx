import { createSignal, For, Show, type Component } from "solid-js";
import { useDb } from "@/shared/db/DbProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

const DevicesSection: Component = () => {
  const { db } = useDb();
  const [tick, setTick] = createSignal(0);

  const heads = () => {
    tick();
    return db.store.heads("notes");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>
          Every device that has synced at least one note in this space, by its op-log identity.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <p class="break-all text-sm text-muted-foreground" data-testid="this-device-id">
          This device: {shortId(db.store.deviceId)}
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="devices-refresh"
          onClick={() => setTick((n) => n + 1)}
        >
          Refresh
        </Button>
        <Show
          when={heads().length > 0}
          fallback={
            <p class="text-sm text-muted-foreground" data-testid="devices-empty">
              No other devices have synced yet.
            </p>
          }
        >
          <ul class="space-y-2" data-testid="devices-list">
            <For each={heads()}>
              {(head) => (
                <li class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <span class="break-all font-mono text-xs">{shortId(head.device)}</span>
                  <div class="flex items-center gap-2">
                    <Show when={head.device === db.store.deviceId}>
                      <Badge variant="secondary">this device</Badge>
                    </Show>
                    <Badge variant="outline">
                      {head.seq} op{head.seq === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Alert data-testid="devices-trust-note">
          <AlertDescription>
            Anyone holding the space key from a pairing code can add a device to this list —
            signatures give attribution to who made which change, not access control. Removing a
            device from a space (revocation) isn't supported yet.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
};

export default DevicesSection;
