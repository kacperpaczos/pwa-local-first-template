import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { Bot, NotebookPen, Settings } from "lucide-solid";
import { appName } from "@/shared/lib";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const HomePage: Component = () => {
  return (
    <div class="mx-auto flex max-w-2xl flex-col gap-6 py-2 sm:py-6">
      <section class="space-y-3">
        <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Local-first
        </p>
        <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">{appName}</h1>
        <p class="max-w-xl text-sm text-muted-foreground sm:text-base">
          Solid.js, Vite, TanStack DB (SQLite/OPFS) and outbox — ready for sync. On-device AI lives
          on its own page so model memory does not fight note storage.
        </p>
        <div class="flex flex-col gap-2 pt-1 sm:flex-row">
          <Button as={A} href="/notes" class="w-full sm:w-auto">
            <NotebookPen class="size-4" />
            Open notes
          </Button>
          <Button as={A} href="/ai" variant="outline" class="w-full sm:w-auto">
            <Bot class="size-4" />
            Open AI
          </Button>
        </div>
      </section>

      <div class="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader class="pb-2">
            <CardTitle class="text-base">Notes</CardTitle>
            <CardDescription>Offline-first CRUD with soft delete and sync.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button as={A} href="/notes" variant="secondary" size="sm" class="w-full">
              Go to notes
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader class="pb-2">
            <CardTitle class="text-base">Settings</CardTitle>
            <CardDescription>Backups, pairing, theme, and storage durability.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button as={A} href="/settings" variant="secondary" size="sm" class="w-full">
              <Settings class="size-4" />
              Open settings
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default HomePage;
