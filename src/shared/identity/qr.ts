import QRCode from "qrcode";
import { exportIdentityJson } from "./pair";
import { exportPairingJson, type PairingPayload } from "./pairing";
import type { SeaPair } from "./types";

/** Encode the full identity payload as a QR data URL (PNG). Treat as a secret. */
export async function identityToQrDataUrl(pair: SeaPair): Promise<string> {
  return QRCode.toDataURL(exportIdentityJson(pair), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
  });
}

/** Encode a v2 pairing payload (SEA + space key + SAS) as a QR data URL. */
export async function pairingToQrDataUrl(payload: PairingPayload): Promise<string> {
  return QRCode.toDataURL(exportPairingJson(payload), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
  });
}
