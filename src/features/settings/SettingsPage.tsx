import { createSignal, For, Show, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { Download, KeyRound, QrCode, Trash2, Upload } from "lucide-solid";
import { toast } from "solid-sonner";
import { useDb } from "@/shared/db/DbProvider";
import { downloadBackupFile, exportNotesAsBackup } from "@/backup/export";
import { importBackup, parseBackupFile } from "@/backup/import";
import { downloadSqlDump, exportDatabaseAsSql } from "@/backup/sqlite-export";
import { lastBackupExportAtStore, recordBackupExport, storagePersistStore } from "@/backup/status";
import { gcTombstones } from "@/shared/sync/gc";
import { parseSyncCursorSeq } from "@/shared/sync/checkpoint";
import { readSyncCursor } from "@/shared/sync/apply-remote";
import {
  listConflicts,
  type ConflictEntry,
} from "@/shared/sync/conflict-log";
import {
  buildPairingPayload,
  createRecoveryBundle,
  exportPairingJson,
  generateRecoveryPhrase,
  getSpaceKey,
  importIdentityJson,
  importPairingPayload,
  isValidRecoveryPhrase,
  loadSpaceId,
  loadStoredPair,
  normalizeMnemonic,
  pairingToQrDataUrl,
  parseRecoveryBundle,
  pickConfirmationIndices,
  restoreFromRecovery,
  verifyConfirmationWords,
} from "@/shared/identity";
import ModeToggle from "@/components/ModeToggle";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "@/components/ui/text-field";

function persistLabel(status: ReturnType<typeof storagePersistStore.get>): string {
  switch (status) {
    case "persisted":
      return "Your data is protected from automatic cleanup.";
    case "not-persisted":
      return "The browser may clear data if storage runs low. Keep backups.";
    case "unsupported":
      return "This browser does not support persistent storage — keep backups.";
    case "unknown":
      return "Persistence status unknown (no notes saved yet).";
  }
}

type ConfirmSlot = { index: number; value: string };

const SettingsPage: Component = () => {
  const { db, facade } = useDb();
  const lastExportAt = useStore(lastBackupExportAtStore);
  const persistStatus = useStore(storagePersistStore);
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [pairingJson, setPairingJson] = createSignal("");
  const [sasDigits, setSasDigits] = createSignal<string | null>(null);
  const [importText, setImportText] = createSignal("");
  const [pubPreview, setPubPreview] = createSignal<string | null>(
    loadStoredPair()?.pub ?? null,
  );
  const [spacePreview, setSpacePreview] = createSignal<string | null>(loadSpaceId());

  // Recovery phrase flow
  const [recoveryPhrase, setRecoveryPhrase] = createSignal<string | null>(null);
  const [confirmSlots, setConfirmSlots] = createSignal<ConfirmSlot[]>([]);
  const [recoveryConfirmed, setRecoveryConfirmed] = createSignal(false);
  const [recoveryBundleJson, setRecoveryBundleJson] = createSignal("");
  const [importPhrase, setImportPhrase] = createSignal("");
  const [importBundleText, setImportBundleText] = createSignal("");

  const [conflictsOpen, setConflictsOpen] = createSignal(false);
  const [conflicts, setConflicts] = createSignal<ConflictEntry[]>(listConflicts());

  const refreshConflicts = () => {
    setConflicts(listConflicts());
  };

  const onRunCleanup = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const coveredSeq = parseSyncCursorSeq(readSyncCursor(db.syncMeta));
      const removed = await gcTombstones(
        db.notes,
        coveredSeq > 0 ? { coveredSeq } : {},
      );
      setStatus(
        removed === 0
          ? "Cleanup finished — no expired tombstones."
          : `Cleanup removed ${removed} expired tombstone${removed === 1 ? "" : "s"}.`,
      );
      toast.success("Cleanup finished");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onRestoreConflict = async (entry: ConflictEntry) => {
    if (entry.field !== "title" || entry.lostValue == null) return;
    setBusy(true);
    setStatus(null);
    try {
      await facade.updateNote(entry.noteId, { title: entry.lostValue });
      toast.success("Restored previous title");
      setStatus(`Restored title for note ${entry.noteId.slice(0, 8)}…`);
      refreshConflicts();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const backup = exportNotesAsBackup(db.notes);
      downloadBackupFile(backup);
      recordBackupExport(backup.exportedAt);
      setStatus(`Downloaded backup: ${backup.notes.length} notes.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onExportSql = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const sql = await exportDatabaseAsSql(db);
      downloadSqlDump(sql);
      setStatus("Downloaded SQLite SQL dump (forensic/offline inspection).");
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
      setStatus(`Imported ${summary.applied}/${summary.totalInBackup} notes.`);
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
      const payload = await buildPairingPayload();
      setPubPreview(payload.pair.pub);
      setSpacePreview(payload.spaceId);
      setSasDigits(payload.sasDigits);
      setPairingJson(exportPairingJson(payload));
      setQrDataUrl(await pairingToQrDataUrl(payload));
      setStatus(
        "Pairing code ready — compare the 6-digit SAS on both devices. Treat the QR like a password.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onHidePairing = () => {
    setQrDataUrl(null);
    setPairingJson("");
    setSasDigits(null);
  };

  const onImportPairing = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const text = importText().trim();
      let pairPub: string;
      try {
        const payload = await importPairingPayload(text);
        pairPub = payload.pair.pub;
        setSpacePreview(payload.spaceId);
        setSasDigits(payload.sasDigits);
      } catch (pairingError) {
        // Backward compatible: accept legacy v1 identity JSON (SEA only).
        try {
          const pair = importIdentityJson(text);
          pairPub = pair.pub;
        } catch {
          throw pairingError instanceof Error
            ? pairingError
            : new Error(String(pairingError));
        }
      }
      setPubPreview(pairPub);
      setImportText("");
      await db.reinitSyncTransport();
      toast.success("Identity imported — sync transport restarted");
      setStatus("Identity imported. Sync transport reinitialized with the new keys.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onGenerateRecovery = () => {
    setStatus(null);
    setRecoveryConfirmed(false);
    setRecoveryBundleJson("");
    const phrase = generateRecoveryPhrase();
    setRecoveryPhrase(phrase);
    const words = phrase.split(" ");
    const indices = pickConfirmationIndices(words.length, 3);
    setConfirmSlots(indices.map((index) => ({ index, value: "" })));
  };

  const onConfirmRecovery = async () => {
    const phrase = recoveryPhrase();
    if (!phrase) return;
    setBusy(true);
    setStatus(null);
    try {
      const ok = verifyConfirmationWords(
        phrase,
        confirmSlots().map((s) => ({ index: s.index, word: s.value })),
      );
      if (!ok) {
        setStatus("Confirmation words do not match. Check the phrase and try again.");
        return;
      }
      const payload = await buildPairingPayload();
      const key = await getSpaceKey();
      const recoveryBundle = await createRecoveryBundle(payload.spaceId, key, phrase);
      setRecoveryBundleJson(JSON.stringify(recoveryBundle));
      setRecoveryConfirmed(true);
      setStatus("Recovery phrase confirmed. Download or copy the recovery bundle below.");
      toast.success("Recovery phrase confirmed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onImportRecovery = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const phrase = normalizeMnemonic(importPhrase());
      if (!isValidRecoveryPhrase(phrase)) {
        throw new Error("Invalid recovery phrase");
      }
      const bundle = parseRecoveryBundle(JSON.parse(importBundleText()) as unknown);
      await restoreFromRecovery(phrase, bundle);
      setSpacePreview(bundle.spaceId);
      setImportPhrase("");
      setImportBundleText("");
      await db.reinitSyncTransport();
      toast.success("Space key restored — sync transport restarted");
      setStatus("Space key restored from recovery phrase. Sync transport reinitialized.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const downloadRecoveryBundle = () => {
    const json = recoveryBundleJson();
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pwa-space-recovery.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="mx-auto max-w-2xl space-y-4 md:space-y-6">
      <PageHeader
        title="Settings"
        description="Appearance, backup, device pairing, recovery, and storage durability."
      />

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Switch between light, dark, or system theme.</CardDescription>
        </CardHeader>
        <CardContent class="flex items-center justify-between gap-3">
          <p class="text-sm text-muted-foreground">Color mode</p>
          <ModeToggle />
        </CardContent>
      </Card>

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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Device pairing</CardTitle>
          <CardDescription>
            Share SEA identity + space key via QR. Compare the 6-digit SAS on both devices before
            trusting the link.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="break-all text-sm text-muted-foreground" data-testid="identity-pub">
            Public key: {pubPreview() ?? "(none — generated on first sync)"}
          </p>
          <p class="break-all text-sm text-muted-foreground" data-testid="space-id">
            Space: {spacePreview() ?? "(none)"}
          </p>
          <Button
            class="w-full sm:w-auto"
            data-testid="pairing-show"
            disabled={busy()}
            onClick={() => void onShowPairing()}
          >
            <QrCode class="size-4" />
            Show pairing code
          </Button>

          <Show when={qrDataUrl()}>
            {(url) => (
              <div class="space-y-3 rounded-lg border p-3" data-testid="pairing-qr-wrap">
                <Show when={sasDigits()}>
                  {(sas) => (
                    <p
                      class="text-center font-mono text-2xl tracking-[0.3em]"
                      data-testid="pairing-sas"
                    >
                      {sas()}
                    </p>
                  )}
                </Show>
                <p class="text-center text-xs text-muted-foreground">
                  Short authentication string — must match on the other device
                </p>
                <img
                  data-testid="pairing-qr"
                  src={url()}
                  alt="Pairing QR code"
                  width={256}
                  height={256}
                  class="mx-auto rounded-md bg-white p-2"
                />
                <TextField>
                  <TextFieldLabel>Pairing JSON</TextFieldLabel>
                  <TextFieldTextArea
                    data-testid="pairing-json"
                    readonly
                    rows={4}
                    class="font-mono text-xs"
                    value={pairingJson()}
                  />
                </TextField>
                <Button
                  variant="outline"
                  class="w-full sm:w-auto"
                  data-testid="pairing-hide"
                  onClick={onHidePairing}
                >
                  Hide code
                </Button>
              </div>
            )}
          </Show>

          <Separator />

          <TextField>
            <TextFieldLabel>Paste code from another device</TextFieldLabel>
            <TextFieldTextArea
              data-testid="pairing-import"
              rows={3}
              class="font-mono text-xs"
              value={importText()}
              onInput={(e) => setImportText(e.currentTarget.value)}
              placeholder='{"v":2,"pair":{...},"spaceId":"...","spaceKey":"...","sasDigits":"123456"}'
            />
          </TextField>
          <Button
            class="w-full sm:w-auto"
            data-testid="pairing-import-submit"
            disabled={busy() || importText().trim().length === 0}
            onClick={() => void onImportPairing()}
          >
            <Upload class="size-4" />
            Import identity
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recovery phrase</CardTitle>
          <CardDescription>
            12-word BIP39 phrase wraps your space key. Generate once, confirm three words, then keep
            the recovery bundle with the phrase.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Button
            class="w-full sm:w-auto"
            data-testid="recovery-generate"
            disabled={busy()}
            onClick={onGenerateRecovery}
          >
            <KeyRound class="size-4" />
            Generate recovery phrase
          </Button>

          <Show when={recoveryPhrase()}>
            {(phrase) => (
              <div class="space-y-3 rounded-lg border p-3" data-testid="recovery-phrase-wrap">
                <p class="font-mono text-sm leading-relaxed" data-testid="recovery-phrase">
                  {phrase()}
                </p>
                <Show when={!recoveryConfirmed()}>
                  <div class="space-y-2">
                    <p class="text-sm text-muted-foreground">
                      Confirm by typing these words from the phrase:
                    </p>
                    <For each={confirmSlots()}>
                      {(slot, i) => (
                        <TextField>
                          <TextFieldLabel>Word #{slot.index + 1}</TextFieldLabel>
                          <TextFieldInput
                            data-testid={`recovery-confirm-${i()}`}
                            value={slot.value}
                            autocomplete="off"
                            onInput={(e) => {
                              const value = e.currentTarget.value;
                              setConfirmSlots((prev) =>
                                prev.map((s) =>
                                  s.index === slot.index ? { ...s, value } : s,
                                ),
                              );
                            }}
                          />
                        </TextField>
                      )}
                    </For>
                    <Button
                      data-testid="recovery-confirm"
                      disabled={busy()}
                      onClick={() => void onConfirmRecovery()}
                    >
                      Confirm phrase
                    </Button>
                  </div>
                </Show>
                <Show when={recoveryConfirmed() && recoveryBundleJson()}>
                  <div class="space-y-2">
                    <TextField>
                      <TextFieldLabel>Recovery bundle (store with your phrase)</TextFieldLabel>
                      <TextFieldTextArea
                        data-testid="recovery-bundle"
                        readonly
                        rows={3}
                        class="font-mono text-xs"
                        value={recoveryBundleJson()}
                      />
                    </TextField>
                    <Button
                      variant="outline"
                      data-testid="recovery-download"
                      onClick={downloadRecoveryBundle}
                    >
                      <Download class="size-4" />
                      Download recovery bundle
                    </Button>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Separator />

          <TextField>
            <TextFieldLabel>Import recovery phrase</TextFieldLabel>
            <TextFieldTextArea
              data-testid="recovery-import-phrase"
              rows={2}
              class="font-mono text-xs"
              value={importPhrase()}
              onInput={(e) => setImportPhrase(e.currentTarget.value)}
              placeholder="twelve word recovery phrase …"
            />
          </TextField>
          <TextField>
            <TextFieldLabel>Recovery bundle JSON</TextFieldLabel>
            <TextFieldTextArea
              data-testid="recovery-import-bundle"
              rows={3}
              class="font-mono text-xs"
              value={importBundleText()}
              onInput={(e) => setImportBundleText(e.currentTarget.value)}
              placeholder='{"v":1,"spaceId":"...","wrapped":{...}}'
            />
          </TextField>
          <Button
            class="w-full sm:w-auto"
            data-testid="recovery-import-submit"
            disabled={
              busy() ||
              importPhrase().trim().length === 0 ||
              importBundleText().trim().length === 0
            }
            onClick={() => void onImportRecovery()}
          >
            <Upload class="size-4" />
            Restore space key
          </Button>
        </CardContent>
      </Card>

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

      <Show when={status()}>
        {(message) => (
          <Alert data-testid="backup-status">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
    </div>
  );
};

export default SettingsPage;
