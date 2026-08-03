import { createSignal, Show, type Component } from "solid-js";
import { A } from "@solidjs/router";
import { useStore } from "@nanostores/solid";
import { useDb } from "@/shared/db/DbProvider";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";
import { lastBackupExportAtStore, recordBackupExport, storagePersistStore } from "@/backup/status";
import {
  ensurePair,
  exportIdentityJson,
  identityToQrDataUrl,
  importIdentityJson,
  loadStoredPair,
} from "@/shared/identity";

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
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [pairingJson, setPairingJson] = createSignal("");
  const [importText, setImportText] = createSignal("");
  const [pubPreview, setPubPreview] = createSignal<string | null>(
    loadStoredPair()?.pub ?? null,
  );

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

  const onShowPairing = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const pair = await ensurePair();
      setPubPreview(pair.pub);
      setPairingJson(exportIdentityJson(pair));
      setQrDataUrl(await identityToQrDataUrl(pair));
      setStatus("Kod parowania gotowy — traktuj go jak hasło (pełny dostęp do konta).");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onHidePairing = () => {
    setQrDataUrl(null);
    setPairingJson("");
  };

  const onImportPairing = () => {
    setStatus(null);
    setBusy(true);
    try {
      const pair = importIdentityJson(importText().trim());
      setPubPreview(pair.pub);
      setImportText("");
      setStatus(
        "Zaimportowano tożsamość. Odśwież stronę, żeby sync użył nowej pary kluczy.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
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
      </section>

      <section style={{ "margin-top": "1.5rem" }}>
        <h2>Parowanie urządzeń</h2>
        <p>
          Ta sama para kluczy SEA na każdym urządzeniu = ten sam użytkownik syncu.
          Kod QR zawiera klucz prywatny — nie udostępniaj go osobom trzecim.
        </p>
        <p data-testid="identity-pub">
          Klucz publiczny: {pubPreview() ?? "(brak — wygeneruje się przy syncu)"}
        </p>
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <button
            type="button"
            data-testid="pairing-show"
            disabled={busy()}
            onClick={() => void onShowPairing()}
          >
            Pokaż kod parowania
          </button>
          <Show when={qrDataUrl()}>
            {(url) => (
              <div data-testid="pairing-qr-wrap">
                <img data-testid="pairing-qr" src={url()} alt="Kod QR parowania" width={256} height={256} />
                <textarea
                  data-testid="pairing-json"
                  readonly
                  rows={4}
                  style={{ width: "100%", "font-family": "monospace", "font-size": "0.75rem" }}
                  value={pairingJson()}
                />
                <button type="button" data-testid="pairing-hide" onClick={onHidePairing}>
                  Ukryj kod
                </button>
              </div>
            )}
          </Show>
          <label>
            Wklej kod z innego urządzenia
            <textarea
              data-testid="pairing-import"
              rows={3}
              style={{ width: "100%", "font-family": "monospace", "font-size": "0.75rem" }}
              value={importText()}
              onInput={(e) => setImportText(e.currentTarget.value)}
              placeholder='{"v":1,"pair":{...}}'
            />
          </label>
          <button
            type="button"
            data-testid="pairing-import-submit"
            disabled={busy() || importText().trim().length === 0}
            onClick={onImportPairing}
          >
            Zaimportuj tożsamość
          </button>
        </div>
      </section>

      <section style={{ "margin-top": "1.5rem" }}>
        <h2>Trwałość danych</h2>
        <p data-testid="storage-persist-status">{persistLabel(persistStatus())}</p>
      </section>

      <Show when={status()}>{(message) => <p data-testid="backup-status">{message()}</p>}</Show>
    </main>
  );
};

export default SettingsPage;
