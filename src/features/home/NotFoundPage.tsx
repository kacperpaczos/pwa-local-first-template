import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { Home } from "lucide-solid";
import { Button } from "@/components/ui/button";

const NotFoundPage: Component = () => {
  return (
    <div class="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">404</p>
      <h1 class="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p class="text-sm text-muted-foreground">
        There is nothing at this address. Your notes are safe — they live in this browser.
      </p>
      <Button as={A} href="/" class="mt-2">
        <Home class="size-4" />
        Back to home
      </Button>
    </div>
  );
};

export default NotFoundPage;
