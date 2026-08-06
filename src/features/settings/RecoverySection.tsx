import { createSignal, For, Show, type Component } from "solid-js";
import { Download, KeyRound, Upload } from "lucide-solid";
import { toast } from "solid-sonner";
import { useDb } from "@/shared/db/DbProvider";
import {
  buildPairingPayload,
  createRecoveryBundle,
  generateRecoveryPhrase,
  getSpaceKey,
  isValidRecoveryPhrase,
  normalizeMnemonic,
  parseRecoveryBundle,
  pickConfirmationIndices,
  restoreFromRecovery,
  verifyConfirmationWords,
} from "@/shared/identity";
import { createAsyncAction } from "@/shared/lib/async-action";
import { triggerDownload } from "@/shared/lib/download";
import { setSpacePreview } from "./identity-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { TextField, TextFieldInput, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";

type ConfirmSlot = { index: number; value: string };

const RecoverySection: Component = () => {
  const { db } = useDb();
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [recoveryPhrase, setRecoveryPhrase] = createSignal<string | null>(null);
  const [confirmSlots, setConfirmSlots] = createSignal<ConfirmSlot[]>([]);
  const [recoveryConfirmed, setRecoveryConfirmed] = createSignal(false);
  const [recoveryBundleJson, setRecoveryBundleJson] = createSignal("");
  const [importPhrase, setImportPhrase] = createSignal("");
  const [importBundleText, setImportBundleText] = createSignal("");

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

  const onConfirmRecovery = createAsyncAction(setBusy, setStatus, async () => {
    const phrase = recoveryPhrase();
    if (!phrase) return;
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
  });

  const onImportRecovery = createAsyncAction(setBusy, setStatus, async () => {
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
  });

  const downloadRecoveryBundle = () => {
    const json = recoveryBundleJson();
    if (!json) return;
    triggerDownload(json, "pwa-space-recovery.json", "application/json");
  };

  return (
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
                              prev.map((s) => (s.index === slot.index ? { ...s, value } : s)),
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
                  <Button variant="outline" data-testid="recovery-download" onClick={downloadRecoveryBundle}>
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
            busy() || importPhrase().trim().length === 0 || importBundleText().trim().length === 0
          }
          onClick={() => void onImportRecovery()}
        >
          <Upload class="size-4" />
          Restore space key
        </Button>

        <Show when={status()}>
          {(message) => (
            <Alert data-testid="recovery-status">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
      </CardContent>
    </Card>
  );
};

export default RecoverySection;
