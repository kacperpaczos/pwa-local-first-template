import { createMemo, createSignal, Show, type Component } from "solid-js";
import { useLiveQuery } from "@tanstack/solid-db";
import { Plus, RefreshCw } from "lucide-solid";
import { useDb } from "@/shared/db/DbProvider";
import { COUNTER_ID, type Counter } from "@/shared/db/schemas";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";

/**
 * The entire demo domain: one shared counter with a label.
 *
 * The button appends a `+1` op to this device's log — increments from any
 * number of devices SUM (grow-only counter), so two devices clicking at the
 * same time yields +2 everywhere. The label is last-writer-wins — concurrent
 * edits keep exactly one value, deterministically, on every device.
 * Everything else in this repo exists to move those two ops around.
 */
const CounterPage: Component = () => {
  const { db, facade } = useDb();
  const [error, setError] = createSignal<string | null>(null);
  const [labelDraft, setLabelDraft] = createSignal<string | null>(null);

  const counterQuery = useLiveQuery((q) => q.from({ counter: db.counter }));
  const counter = createMemo<Counter | undefined>(() =>
    ((counterQuery() ?? []) as Counter[]).find((row) => row.id === COUNTER_ID),
  );

  const value = () => counter()?.value ?? 0;
  const label = () => counter()?.label ?? "";

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  return (
    <div class="space-y-4 md:space-y-6">
      <PageHeader
        title="Counter"
        description="One shared counter, synced across your devices"
        data-testid="sync-status"
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="sync-now"
            onClick={() => run(() => db.pullRemote())}
          >
            <RefreshCw class="size-4" />
            Sync now
          </Button>
        }
      />

      <Card class="mx-auto max-w-md" data-testid="counter-card">
        <CardHeader>
          <CardTitle class="text-center text-6xl tabular-nums" data-testid="counter-value">
            {value()}
          </CardTitle>
          <CardDescription class="text-center">
            Increments from every paired device add up — they never conflict.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Button
            class="w-full"
            size="lg"
            data-testid="counter-increment"
            onClick={() => run(() => facade.increment())}
          >
            <Plus class="size-4" />
            Increment
          </Button>

          <form
            class="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = labelDraft();
              if (next === null || next === label()) return;
              run(async () => {
                await facade.setLabel(next);
                setLabelDraft(null);
              });
            }}
          >
            <TextField>
              <TextFieldLabel>Label</TextFieldLabel>
              <TextFieldInput
                type="text"
                placeholder="What is this counter for?"
                data-testid="counter-label"
                value={labelDraft() ?? label()}
                onInput={(event) => setLabelDraft(event.currentTarget.value)}
              />
            </TextField>
            <Button
              type="submit"
              variant="secondary"
              class="w-full"
              data-testid="counter-label-save"
              disabled={labelDraft() === null || labelDraft() === label()}
            >
              Save label
            </Button>
          </form>

          <Show when={error()}>
            <Alert variant="destructive" data-testid="counter-error">
              <AlertDescription>{error()}</AlertDescription>
            </Alert>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
};

export default CounterPage;
