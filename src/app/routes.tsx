import { Route } from "@solidjs/router";
import type { Component } from "solid-js";
import CounterPage from "@/features/counter/CounterPage";
import NotFoundPage from "@/features/counter/NotFoundPage";
import SettingsPage from "@/features/settings/SettingsPage";

export const AppRoutes: Component = () => {
  return (
    <>
      <Route path="/" component={CounterPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="*404" component={NotFoundPage} />
    </>
  );
};
