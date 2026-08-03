import {
  exportIdentityJson,
  importIdentityJson,
  loadStoredPair,
} from "./pair";
import type { SeaPair } from "./types";

type IdentityE2eHooks = {
  __exportIdentity?: () => string | null;
  __importIdentity?: (payload: string | SeaPair | { v: 1; pair: SeaPair }) => string;
};

/**
 * Playwright harness: import/export SEA pair without camera QR.
 * Only registered when DEV or VITE_E2E=1.
 */
export function exposeIdentityE2eHooks(): void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_E2E === "1")) {
    return;
  }

  const hooks = globalThis as unknown as IdentityE2eHooks;

  hooks.__exportIdentity = () => {
    const pair = loadStoredPair();
    return pair ? exportIdentityJson(pair) : null;
  };

  hooks.__importIdentity = (payload) => {
    const text =
      typeof payload === "string"
        ? payload
        : JSON.stringify(
            "pair" in payload && "v" in payload
              ? payload
              : { v: 1 as const, pair: payload as SeaPair },
          );
    const pair = importIdentityJson(text);
    return exportIdentityJson(pair);
  };
}
