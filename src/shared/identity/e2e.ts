import { exportIdentityJson, importIdentityJson, loadStoredPair } from "./pair";
import type { SeaPair } from "./types";

type IdentityE2eHooks = {
  __exportIdentity?: () => string | null;
  __importIdentity?: (payload: string | SeaPair | { v: 1; pair: SeaPair }) => string;
};

/**
 * DEV-console tooling to import/export a SEA pair without camera QR.
 * Only registered when DEV or VITE_E2E=1.
 *
 * Note: the automated Playwright suite does NOT call these — it seeds
 * `localStorage` directly via `addInitScript` in `e2e/helpers.ts` before the
 * app's first navigation, since these hooks are only available post-mount
 * and can't seed the space key alongside the pair. Kept for manual
 * debugging (open devtools console, call `__exportIdentity()`/
 * `__importIdentity(...)`).
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
