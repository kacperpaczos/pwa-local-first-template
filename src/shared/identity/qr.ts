import QRCode from "qrcode";
import { exportIdentityJson } from "./pair";
import type { SeaPair } from "./types";

/** Encode the full identity payload as a QR data URL (PNG). Treat as a secret. */
export async function identityToQrDataUrl(pair: SeaPair): Promise<string> {
  return QRCode.toDataURL(exportIdentityJson(pair), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
  });
}
