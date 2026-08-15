import { Route } from "@solidjs/router";
import type { Component } from "solid-js";
import HomePage from "@/features/home/HomePage";
import NotesPage from "@/features/notes/NotesPage";
import AiPage from "@/features/ai/AiPage";
import SettingsPage from "@/features/settings/SettingsPage";

export const AppRoutes: Component = () => {
  return (
    <>
      <Route path="/" component={HomePage} />
      <Route path="/notes" component={NotesPage} />
      <Route path="/ai" component={AiPage} />
      <Route path="/settings" component={SettingsPage} />
    </>
  );
};
