import { createSignal, Show, type Component } from "solid-js";
import { A } from "@solidjs/router";
import { useStore } from "@nanostores/solid";
import { useDb } from "@/shared/db/DbProvider";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";
import { lastBackupExportAtStore, recordBackupExport, storagePersistStore } from "@/backup/status";

function persistLabel(status: ReturnType<typeof storagePersistStore.get>): string {
  switch (status) {
    case "persisted":
      return "Twoje dane są chronione przed automatycznym czyszczeniem.";
    case "not-persisted":
      return "Przeglądarka może wyczyścić dane, jeśli zabraknie miejsca. Rób kopie zapasowe.";
    case "unsupported":
      return "Ta przeglądarka nie wspiera trwałego storage — rób kopie zapasowe.";
    case "unknown":
      return "Status trwałości nieznany (jeszcze nie zapisano żadnej notatki).";
  }
}

const SettingsPage: Component = () => {
  const { db } = useDb();
  const lastExportAt = useStore(lastBackupExportAtStore);
  const persistStatus = useStore(storagePersistStore);
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const onExport = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const backup = exportNotesAsBackup(db.notes);
      downloadBackupFile(backup);
      recordBackupExport(backup.exportedAt);
      setStatus(`Pobrano kopię: ${backup.notes.length} notatek.`);
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
        { notes: db.notes, syncMeta: db.syncMeta },
        db.syncMutex,
        backup,
      );
      setStatus(`Zaimportowano ${summary.applied}/${summary.totalInBackup} notatek.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      input.value = "";
    }
  };

  return (
    <main style={{ padding: "2rem", "max-width": "40rem", margin: "0 auto" }}>
      <header style={{ display: "flex", "justify-content": "space-between" }}>
        <h1>Ustawienia</h1>
        <A href="/notes">Wróć do notatek</A>
      </header>

      <section style={{ "margin-top": "1.5rem" }}>
        <h2>Kopia zapasowa</h2>
        <p data-testid="last-export-at">
          Ostatni eksport: {lastExportAt() ?? "nigdy"}
        </p>
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <button type="button" data-testid="backup-export" disabled={busy()} onClick={() => void onExport()}>
            Pobierz kopię zapasową
          </button>
          <label>
            Przywróć z kopii
            <input
              type="file"
              accept="application/json"
              data-testid="backup-import"
              disabled={busy()}
              onChange={(e) => void onImport(e)}
            />
          </label>
        </div>
        <Show when={status()}>{(message) => <p data-testid="backup-status">{message()}</p>}</Show>
      </section>

      <section style={{ "margin-top": "1.5rem" }}>
        <h2>Trwałość danych</h2>
        <p data-testid="storage-persist-status">{persistLabel(persistStatus())}</p>
      </section>
    </main>
  );
};

export default SettingsPage;
