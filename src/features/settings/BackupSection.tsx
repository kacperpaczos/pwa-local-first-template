import { createSignal, Show, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { Download, Trash2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { useDb } from "@/shared/db/DbProvider";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";
import { downloadSqlDump, exportDatabaseAsSql } from "@/backup/sqlite-export";
import { lastBackupExportAtStore, recordBackupExport } from "@/backup/status";
import { gcTombstones } from "@/shared/sync/gc";
import { buildCheckpoint } from "@/shared/sync/checkpoint";
import { createAsyncAction } from "@/shared/lib/async-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const BackupSection: Component = () => {
  const { db } = useDb();
  const lastExportAt = useStore(lastBackupExportAtStore);
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const onExport = createAsyncAction(setBusy, setStatus, async () => {
    const backup = exportNotesAsBackup(db.notes);
    downloadBackupFile(backup);
    recordBackupExport(backup.exportedAt);
    setStatus(`Downloaded backup: ${backup.notes.length} notes.`);
    toast.success("Backup downloaded");
  });

  const onExportSql = createAsyncAction(setBusy, setStatus, async () => {
    const sql = await exportDatabaseAsSql(db);
    downloadSqlDump(sql);
    setStatus("Downloaded SQLite SQL dump (forensic/offline inspection).");
    toast.success("SQL dump downloaded");
  });

  const onImport = createAsyncAction(setBusy, setStatus, async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const backup = parseBackupFile(raw);
      const summary = await importBackup(
        { notes: db.notes, syncMeta: db.syncMeta },
        db.syncMutex,
        backup,
      );
      setStatus(`Imported ${summary.applied}/${summary.totalInBackup} notes.`);
      toast.success("Backup imported");
    } finally {
      input.value = "";
    }
  });

  const onRunCleanup = createAsyncAction(setBusy, setStatus, async () => {
    const coveredSeq = buildCheckpoint(db.notes).seqCovered;
    const removed = await gcTombstones(db.notes, coveredSeq > 0 ? { coveredSeq } : {});
    setStatus(
      removed === 0
        ? "Cleanup finished — no expired tombstones."
        : `Cleanup removed ${removed} expired tombstone${removed === 1 ? "" : "s"}.`,
    );
    toast.success("Cleanup finished");
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Backup</CardTitle>
          <CardDescription data-testid="last-export-at">
            Last export: {lastExportAt() ?? "never"}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <Button
            class="w-full sm:w-auto"
            data-testid="backup-export"
            disabled={busy()}
            onClick={() => void onExport()}
          >
            <Download class="size-4" />
            Download backup
          </Button>
          <Button
            class="w-full sm:w-auto"
            variant="outline"
            data-testid="backup-export-sql"
            disabled={busy()}
            onClick={() => void onExportSql()}
          >
            <Download class="size-4" />
            Download SQL dump
          </Button>
          <label class="block space-y-2 text-sm">
            <span class="font-medium">Restore from backup</span>
            <input
              type="file"
              accept="application/json"
              class="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
              data-testid="backup-import"
              disabled={busy()}
              onChange={(e) => void onImport(e)}
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage cleanup</CardTitle>
          <CardDescription>
            Hard-delete soft-deleted notes older than the 90-day tombstone retention.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            class="w-full sm:w-auto"
            variant="outline"
            data-testid="run-cleanup"
            disabled={busy()}
            onClick={() => void onRunCleanup()}
          >
            <Trash2 class="size-4" />
            Run cleanup
          </Button>
        </CardContent>
      </Card>

      <Show when={status()}>
        {(message) => (
          <Alert data-testid="backup-status">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
    </>
  );
};

export default BackupSection;
