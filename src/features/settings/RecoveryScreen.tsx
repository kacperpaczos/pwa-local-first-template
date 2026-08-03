import { createSignal, type Component } from "solid-js";
import type { AppDatabase } from "@/shared/db/client";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Props = {
  db: AppDatabase;
};

/**
 * Shown instead of a white screen when `PRAGMA integrity_check` fails at
 * startup (Etap 4.0). Offers the two ways out: export whatever rows are
 * still readable, or restore from a previously downloaded backup file.
 */
const RecoveryScreen: Component<Props> = (props) => {
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const onExportReadable = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const backup = exportNotesAsBackup(props.db.notes);
      downloadBackupFile(backup);
      setStatus(`Downloaded backup: ${backup.notes.length} notes.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onImport = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setStatus(null);
    setBusy(true);
    try {
      const raw = await file.text();
      const backup = parseBackupFile(raw);
      const summary = await importBackup(
        { notes: props.db.notes, syncMeta: props.db.syncMeta },
        props.db.syncMutex,
        backup,
      );
      setStatus(
        `Imported ${summary.applied}/${summary.totalInBackup} notes. Refresh the page.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      input.value = "";
    }
  };

  return (
    <main class="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-4 sm:p-6">
      <Alert variant="destructive">
        <AlertTitle>Database corrupted</AlertTitle>
        <AlertDescription>
          Local SQLite integrity check failed. Before overwriting anything, download whatever is
          still readable, or restore from a previous backup.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Recovery</CardTitle>
          <CardDescription>Export readable rows or restore a JSON backup.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <Button
            class="w-full sm:w-auto"
            data-testid="recovery-export"
            disabled={busy()}
            onClick={() => void onExportReadable()}
          >
            Download readable data
          </Button>
          <label class="block space-y-2 text-sm">
            <span class="font-medium">Import from backup</span>
            <input
              type="file"
              accept="application/json"
              class="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
              data-testid="recovery-import"
              disabled={busy()}
              onChange={(e) => void onImport(e)}
            />
          </label>
          {status() && (
            <p class="text-sm text-muted-foreground" data-testid="recovery-status">
              {status()}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
};

export default RecoveryScreen;
