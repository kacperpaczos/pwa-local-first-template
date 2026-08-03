import type { Component, ParentProps } from "solid-js";
import { Router } from "@solidjs/router";
import { DbProvider } from "@/shared/db/DbProvider";
import { initAiFeature } from "@/ai";
import { AppRoutes } from "./routes";

const RootLayout: Component<ParentProps> = (props) => <>{props.children}</>;

initAiFeature();

const App: Component = () => {
  return (
    <DbProvider>
      <Router root={RootLayout}>
        <AppRoutes />
      </Router>
    </DbProvider>
  );
};

export default App;
