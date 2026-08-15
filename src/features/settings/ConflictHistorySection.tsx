import { createSignal, For, Show, type Component } from "solid-js";
import { toast } from "solid-sonner";
import { useDb } from "@/shared/db/DbProvider";
import { listConflicts, type ConflictEntry } from "@/shared/sync/conflict-log";
import { createAsyncAction } from "@/shared/lib/async-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ConflictHistorySection: Component = () => {
  const { db, facade } = useDb();
  const quarantined = () => db.store.quarantined("notes");
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [conflictsOpen, setConflictsOpen] = createSignal(false);
  const [conflicts, setConflicts] = createSignal<ConflictEntry[]>(listConflicts());

  const refreshConflicts = () => {
    setConflicts(listConflicts());
  };

  const onRestoreConflict = createAsyncAction(setBusy, setStatus, async (entry: ConflictEntry) => {
    if (entry.field !== "title" || entry.lostValue == null) return;
    await facade.updateNote(entry.noteId, { title: entry.lostValue });
    toast.success("Restored previous title");
    setStatus(`Restored title for note ${entry.noteId.slice(0, 8)}…`);
    refreshConflicts();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conflict history</CardTitle>
        <CardDescription>
          Lost LWW values from sync merges (title / delete). Retained 30 days, max 200 entries.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="conflict-history-toggle"
          onClick={() => {
            refreshConflicts();
            setConflictsOpen((open) => !open);
          }}
        >
          {conflictsOpen() ? "Hide" : "Show"} conflict history
          <Show when={conflicts().length > 0}>
            <Badge variant="secondary" class="ml-2">
              {conflicts().length}
            </Badge>
          </Show>
        </Button>
        <Show when={conflictsOpen()}>
          <Show
            when={conflicts().length > 0}
            fallback={
              <p class="text-sm text-muted-foreground" data-testid="conflict-history-empty">
                No recorded conflicts.
              </p>
            }
          >
            <ul class="space-y-3" data-testid="conflict-history-list">
              <For each={conflicts()}>
                {(entry) => (
                  <li class="rounded-md border p-3 text-sm">
                    <div class="mb-1 flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{entry.field}</Badge>
                      <span class="font-mono text-xs text-muted-foreground">
                        {entry.noteId.slice(0, 8)}…
                      </span>
                      <span class="text-xs text-muted-foreground">{entry.at}</span>
                    </div>
                    <p class="text-muted-foreground">
                      Lost:{" "}
                      <span class="text-foreground">
                        {entry.lostValue === null ? "(null)" : entry.lostValue}
                      </span>
                    </p>
                    <p class="text-muted-foreground">
                      Won:{" "}
                      <span class="text-foreground">
                        {entry.wonValue === null ? "(null)" : entry.wonValue}
                      </span>
                    </p>
                    <Show when={entry.field === "title" && entry.lostValue != null}>
                      <Button
                        size="sm"
                        class="mt-2"
                        data-testid="conflict-restore"
                        disabled={busy()}
                        onClick={() => void onRestoreConflict(entry)}
                      >
                        Restore
                      </Button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={quarantined().length > 0}>
          <Alert variant="destructive" data-testid="quarantine-list">
            <AlertDescription>
              <p class="mb-2 font-medium">
                {quarantined().length} quarantined sync operation
                {quarantined().length === 1 ? "" : "s"} (sync continues around them):
              </p>
              <ul class="space-y-1">
                <For each={quarantined()}>
                  {(op) => (
                    <li class="font-mono text-xs">
                      {op.device.slice(0, 8)}…#{op.seq} — {op.quarantineReason ?? "unknown"}
                    </li>
                  )}
                </For>
              </ul>
            </AlertDescription>
          </Alert>
        </Show>
        <Show when={status()}>
          {(message) => (
            <Alert data-testid="conflict-status">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
      </CardContent>
    </Card>
  );
};

export default ConflictHistorySection;
