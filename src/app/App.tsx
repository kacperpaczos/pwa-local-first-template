import type { Component, ParentProps } from "solid-js";
import { Router } from "@solidjs/router";
import { ColorModeProvider, createLocalStorageManager } from "@kobalte/core";
import { DbProvider } from "@/shared/db/DbProvider";
import { initAiFeature } from "@/ai";
import AppShell from "./AppShell";
import { AppRoutes } from "./routes";
import AppErrorBoundary from "./AppErrorBoundary";

const THEME_STORAGE_KEY = "pwa-ui-theme";

const RootLayout: Component<ParentProps> = (props) => <AppShell>{props.children}</AppShell>;

initAiFeature();

const App: Component = () => {
  const storageManager = createLocalStorageManager(THEME_STORAGE_KEY);

  return (
    <ColorModeProvider storageManager={storageManager}>
      <AppErrorBoundary>
        <DbProvider>
          <Router root={RootLayout}>
            <AppRoutes />
          </Router>
        </DbProvider>
      </AppErrorBoundary>
    </ColorModeProvider>
  );
};

export default App;
