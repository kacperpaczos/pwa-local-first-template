import { createSignal, Show, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { QrCode, Upload } from "lucide-solid";
import { toast } from "solid-sonner";
import { useDb } from "@/shared/db/DbProvider";
import {
  buildPairingPayload,
  commitPairingPayload,
  exportPairingJson,
  pairingToQrDataUrl,
  previewPairingPayload,
  type PairingPayload,
} from "@/shared/identity";
import { createAsyncAction } from "@/shared/lib/async-action";
import {
  pubPreviewStore,
  setPubPreview,
  setSpacePreview,
  spacePreviewStore,
} from "./identity-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "@/components/ui/text-field";

const PairingSection: Component = () => {
  const { db } = useDb();
  const pubPreview = useStore(pubPreviewStore);
  const spacePreview = useStore(spacePreviewStore);
  const [status, setStatus] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [pairingJson, setPairingJson] = createSignal("");
  const [sasDigits, setSasDigits] = createSignal<string | null>(null);
  const [importText, setImportText] = createSignal("");
  const [importPreview, setImportPreview] = createSignal<PairingPayload | null>(null);
  const [importSasDigits, setImportSasDigits] = createSignal<string | null>(null);
  const [confirmSasInput, setConfirmSasInput] = createSignal("");

  const onShowPairing = createAsyncAction(setBusy, setStatus, async () => {
    const payload = await buildPairingPayload();
    setPubPreview(payload.pair.pub);
    setSpacePreview(payload.spaceId);
    setSasDigits(payload.sasDigits);
    setPairingJson(exportPairingJson(payload));
    setQrDataUrl(await pairingToQrDataUrl(payload));
    setStatus(
      "Pairing code ready — compare the 6-digit SAS on both devices. Treat the QR like a password.",
    );
  });

  const onHidePairing = () => {
    setQrDataUrl(null);
    setPairingJson("");
    setSasDigits(null);
  };

  /**
   * Step 1: parse the pasted code and show its SAS — nothing is persisted
   * yet. The user must compare this SAS against what the *other* device is
   * showing (out-of-band: voice, in person) and only then confirm below.
   * See commitPairingPayload's doc comment for why this gate exists: the
   * payload's own sasDigits is self-derived and cannot detect a fully
   * forged payload on its own.
   *
   * A payload that fails to parse (wrong/old version, corrupt JSON, missing
   * fields) is a hard stop — the error is shown as-is. There is no fallback
   * to a weaker, unconfirmed import path here: a previous version of this
   * screen silently accepted legacy v1 identity JSON with no SAS check at
   * all whenever v2 parsing failed, which routed any malformed-on-purpose
   * payload straight around the SAS gate.
   */
  const onPreviewImportPairing = createAsyncAction(setBusy, setStatus, async () => {
    const text = importText().trim();
    const payload = await previewPairingPayload(text);
    setImportPreview(payload);
    setImportSasDigits(payload.sasDigits);
    setConfirmSasInput("");
    setStatus(
      "Code parsed. Compare the SAS below with the other device, then enter it to confirm the import.",
    );
  });

  const onCancelImportPreview = () => {
    setImportPreview(null);
    setImportSasDigits(null);
    setConfirmSasInput("");
  };

  /** Step 2: commit only once the user typed the SAS shown on the other device. */
  const onConfirmImportPairing = createAsyncAction(setBusy, setStatus, async () => {
    const preview = importPreview();
    if (!preview) return;
    const committed = await commitPairingPayload(preview, confirmSasInput().trim());
    setPubPreview(committed.pair.pub);
    setSpacePreview(committed.spaceId);
    setImportPreview(null);
    setImportSasDigits(null);
    setConfirmSasInput("");
    setImportText("");
    await db.reinitSyncTransport();
    toast.success("Identity imported — sync transport restarted");
    setStatus("Identity imported. Sync transport reinitialized with the new keys.");
  });

  return (
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
            disabled={importPreview() != null}
            onInput={(e) => setImportText(e.currentTarget.value)}
            placeholder='{"v":3,"pair":{...},"spaceId":"...","spaceKey":"...","sasDigits":"123456","inviterDevice":{"id":"..."}}'
          />
        </TextField>
        <Show
          when={importPreview()}
          fallback={
            <Button
              class="w-full sm:w-auto"
              data-testid="pairing-import-submit"
              disabled={busy() || importText().trim().length === 0}
              onClick={() => void onPreviewImportPairing()}
            >
              <Upload class="size-4" />
              Parse code
            </Button>
          }
        >
          <div class="space-y-3 rounded-lg border p-3" data-testid="pairing-import-confirm">
            <Show when={importSasDigits()}>
              {(sas) => (
                <p
                  class="text-center font-mono text-2xl tracking-[0.3em]"
                  data-testid="pairing-import-sas"
                >
                  {sas()}
                </p>
              )}
            </Show>
            <p class="text-center text-xs text-muted-foreground">
              This is what the pasted code says its SAS is — it does NOT prove who sent it. Ask the
              other device's owner for their SAS (voice, in person) and type it below; it must match
              before anything is imported.
            </p>
            <TextField>
              <TextFieldLabel>SAS from the other device</TextFieldLabel>
              <TextFieldInput
                data-testid="pairing-confirm-sas"
                inputMode="numeric"
                maxLength={6}
                value={confirmSasInput()}
                onInput={(e) => setConfirmSasInput(e.currentTarget.value)}
                placeholder="123456"
              />
            </TextField>
            <div class="flex flex-wrap gap-2">
              <Button
                class="flex-1 sm:flex-none"
                data-testid="pairing-confirm-submit"
                disabled={busy() || confirmSasInput().trim().length !== 6}
                onClick={() => void onConfirmImportPairing()}
              >
                Confirm &amp; import
              </Button>
              <Button
                variant="ghost"
                class="flex-1 sm:flex-none"
                data-testid="pairing-confirm-cancel"
                disabled={busy()}
                onClick={onCancelImportPreview}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Show>

        <Show when={status()}>
          {(message) => (
            <Alert data-testid="pairing-status">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
      </CardContent>
    </Card>
  );
};

export default PairingSection;
