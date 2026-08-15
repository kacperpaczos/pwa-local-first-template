import { atom } from "nanostores";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export const installPromptStore = atom<BeforeInstallPromptEvent | null>(null);

export const installedStore = atom<boolean>(
  typeof window !== "undefined" &&
    window.matchMedia?.("(display-mode: standalone)").matches === true,
);

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPromptStore.set(event as BeforeInstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => {
    installPromptStore.set(null);
    installedStore.set(true);
  });
}

export async function promptInstall(): Promise<void> {
  const event = installPromptStore.get();
  if (!event) return;
  installPromptStore.set(null);
  await event.prompt();
  await event.userChoice;
}
