import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPromptStore, installedStore } from "@/shared/lib/install-prompt";
import InstallAppButton from "./InstallAppButton";

type PromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function fakePromptEvent(): PromptEvent {
  const event = new Event("beforeinstallprompt") as PromptEvent;
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome: "accepted" as const, platform: "web" });
  return event;
}

describe("InstallAppButton", () => {
  beforeEach(() => {
    installPromptStore.set(null);
    installedStore.set(false);
  });

  afterEach(() => {
    cleanup();
    installPromptStore.set(null);
    installedStore.set(false);
  });

  it("renders nothing until the browser offers an install prompt", () => {
    render(() => <InstallAppButton />);
    expect(screen.queryByTestId("install-app")).not.toBeInTheDocument();
  });

  it("shows the button when a prompt is captured and hides it when installed", () => {
    render(() => <InstallAppButton />);
    installPromptStore.set(fakePromptEvent());
    expect(screen.getByTestId("install-app")).toBeInTheDocument();

    installedStore.set(true);
    expect(screen.queryByTestId("install-app")).not.toBeInTheDocument();
  });

  it("invokes the captured prompt on click and consumes it", async () => {
    const event = fakePromptEvent();
    render(() => <InstallAppButton />);
    installPromptStore.set(event);

    screen.getByTestId("install-app").click();
    await Promise.resolve();

    expect(event.prompt).toHaveBeenCalledOnce();
    expect(installPromptStore.get()).toBeNull();
  });
});
