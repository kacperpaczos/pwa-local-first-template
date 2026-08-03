import { createSignal, type Component } from "solid-js";
import type { AppDatabase } from "@/shared/db/client";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";

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
        { notes: props.db.notes, syncMeta: props.db.syncMeta },
        props.db.syncMutex,
        backup,
      );
      setStatus(
        `Zaimportowano ${summary.applied}/${summary.totalInBackup} notatek. Odśwież stronę.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      input.value = "";
    }
  };

  return (
    <main style={{ padding: "2rem", "max-width": "40rem", margin: "0 auto" }}>
      <h1>Baza danych uszkodzona</h1>
      <p>
        Sprawdzenie integralności lokalnej bazy SQLite nie powiodło się. Zanim cokolwiek
        nadpiszemy, pobierz to, co da się jeszcze odczytać, albo przywróć wcześniejszą kopię
        zapasową.
      </p>

      <div style={{ display: "grid", gap: "0.75rem", "margin-top": "1.5rem" }}>
        <button
          type="button"
          data-testid="recovery-export"
          disabled={busy()}
          onClick={() => void onExportReadable()}
        >
          Pobierz to, co czytelne
        </button>

        <label>
          Importuj z kopii zapasowej
          <input
            type="file"
            accept="application/json"
            data-testid="recovery-import"
            disabled={busy()}
            onChange={(e) => void onImport(e)}
          />
        </label>

        {status() && <p data-testid="recovery-status">{status()}</p>}
      </div>
    </main>
  );
};

export default RecoveryScreen;
