/* @refresh reload */
import { render } from "solid-js/web";
import "@/shared/styles/global.css";
import App from "@/app/App";

if (import.meta.env.VITE_E2E !== "1") {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        void import("solid-sonner").then(({ toast }) => {
          toast("Update available", {
            description: "A new version of the app is ready.",
            duration: Number.POSITIVE_INFINITY,
            action: {
              label: "Reload",
              onClick: () => void updateSW(true),
            },
          });
        });
      },
    });
  });
}

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

render(() => <App />, root!);
