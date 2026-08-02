import { Route } from "@solidjs/router";
import type { Component } from "solid-js";
import HomePage from "@/features/home/HomePage";
import NotesPage from "@/features/notes/NotesPage";

export const AppRoutes: Component = () => {
  return (
    <>
      <Route path="/" component={HomePage} />
      <Route path="/notes" component={NotesPage} />
    </>
  );
};
