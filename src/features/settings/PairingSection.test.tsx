import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { DbContext } from "@/shared/db/DbProvider";
import type { AppDatabase } from "@/shared/db/client";
import type { PersistenceFacade } from "@/shared/db/facade";
import PairingSection from "./PairingSection";

function renderWithFakeDb() {
  const db = {} as AppDatabase;
  const facade = {} as PersistenceFacade;
  return render(() => (
    <DbContext.Provider value={{ db, facade }}>
      <PairingSection />
    </DbContext.Provider>
  ));
}

describe("PairingSection — import error path", () => {
  afterEach(cleanup);

  it("shows the parse error for a legacy (pre-v3) payload and never opens the SAS-confirm step", async () => {
    renderWithFakeDb();

    const legacyPayload = JSON.stringify({
      v: 2,
      pair: { pub: "p", priv: "p", epub: "e", epriv: "e" },
      spaceId: "space1",
      spaceKey: "AAAA",
      sasDigits: "123456",
    });

    fireEvent.input(screen.getByTestId("pairing-import"), {
      target: { value: legacyPayload },
    });
    fireEvent.click(screen.getByTestId("pairing-import-submit"));

    const status = await screen.findByTestId("pairing-status");
    expect(status.textContent).toMatch(/older app version/);
    expect(screen.queryByTestId("pairing-import-confirm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pairing-confirm-submit")).not.toBeInTheDocument();
  });

  it("shows the parse error for garbage input without opening the SAS-confirm step", async () => {
    renderWithFakeDb();

    fireEvent.input(screen.getByTestId("pairing-import"), {
      target: { value: "not json at all" },
    });
    fireEvent.click(screen.getByTestId("pairing-import-submit"));

    const status = await screen.findByTestId("pairing-status");
    expect(status.textContent).toBeTruthy();
    expect(screen.queryByTestId("pairing-import-confirm")).not.toBeInTheDocument();
  });
});
