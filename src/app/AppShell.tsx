import { createMemo, For, Show, createEffect, type Component, type ParentProps } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { useColorMode } from "@kobalte/core";
import { useStore } from "@nanostores/solid";
import { Bot, CloudOff, Home, Loader2, NotebookPen, Settings } from "lucide-solid";
import { aiStatusStore } from "@/ai";
import { syncStatusStore } from "@/shared/sync/status";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import ModeToggle from "@/components/ModeToggle";
import InstallAppButton from "@/components/InstallAppButton";
import { appName } from "@/shared/lib";

const baseNavItems: Array<{
  title: string;
  url: string;
  icon: typeof Home;
  end?: boolean;
  aiOnly?: boolean;
}> = [
  { title: "Home", url: "/", icon: Home, end: true },
  { title: "Notes", url: "/notes", icon: NotebookPen },
  { title: "AI", url: "/ai", icon: Bot, aiOnly: true },
  { title: "Settings", url: "/settings", icon: Settings },
];

const syncBadge: Record<
  ReturnType<typeof syncStatusStore.get>,
  { label: string; variant: "success" | "secondary" | "warning" | "error" }
> = {
  idle: { label: "Synced", variant: "success" },
  syncing: { label: "Syncing…", variant: "secondary" },
  offline: { label: "Offline", variant: "error" },
  locked: { label: "Locked", variant: "warning" },
  outdated: { label: "Outdated", variant: "warning" },
  degraded: { label: "Degraded", variant: "warning" },
};

const pageTitle = (pathname: string): string => {
  if (pathname === "/") return "Home";
  if (pathname.startsWith("/notes")) return "Notes";
  if (pathname.startsWith("/ai")) return "AI";
  if (pathname.startsWith("/settings")) return "Settings";
  return appName;
};

const AppShell: Component<ParentProps> = (props) => {
  const location = useLocation();
  const { colorMode } = useColorMode();
  const aiStatus = useStore(aiStatusStore);
  const syncStatus = useStore(syncStatusStore);
  const navItems = createMemo(() =>
    baseNavItems.filter((item) => {
      if (!item.aiOnly) return true;
      const s = aiStatus();
      // Hide only when the feature flag is off. Keep the link for no-webgpu so
      // users (and e2e) can reach the unavailable explanation without a full
      // document reload that would re-open OPFS.
      return !(s.kind === "unavailable" && s.reason === "disabled");
    }),
  );

  createEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute("content", colorMode() === "dark" ? "#0f1419" : "#f4f7fb");
  });

  return (
    <SidebarProvider>
      <Sidebar collapsible="offcanvas" variant="sidebar">
        <SidebarHeader class="gap-2 px-3 py-3">
          <A
            href="/"
            class="flex min-w-0 items-center gap-2 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2"
          >
            <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-xs font-bold">
              LF
            </div>
            <div class="min-w-0 truncate text-sm font-semibold tracking-tight">{appName}</div>
          </A>
        </SidebarHeader>
        <SidebarSeparator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <For each={navItems()}>
                  {(item) => {
                    const active = () =>
                      item.end
                        ? location.pathname === item.url
                        : location.pathname === item.url ||
                          location.pathname.startsWith(`${item.url}/`);
                    return (
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          as={A}
                          href={item.url}
                          isActive={active()}
                          tooltip={item.title}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  }}
                </For>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter class="gap-2 p-2">
          <InstallAppButton class="w-full" />
          <div class="flex items-center justify-between gap-2 px-1">
            <span class="text-xs text-muted-foreground">Theme</span>
            <ModeToggle />
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset class="min-w-0">
        <header class="sticky top-0 z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70 [padding-top:max(0.5rem,env(safe-area-inset-top))]">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="mr-1 h-4" />
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span class="truncate text-sm font-medium">{pageTitle(location.pathname)}</span>
            <Show when={location.pathname !== "/"}>
              <span class="hidden text-sm text-muted-foreground sm:inline">· Local-first</span>
            </Show>
          </div>
          <Badge
            variant={syncBadge[syncStatus()].variant}
            class="gap-1"
            data-testid="global-sync-status"
          >
            <Show
              when={syncStatus() === "offline"}
              fallback={
                <Show when={syncStatus() === "syncing"}>
                  <Loader2 class="size-3 animate-spin" />
                </Show>
              }
            >
              <CloudOff class="size-3" />
            </Show>
            {syncBadge[syncStatus()].label}
          </Badge>
          <ModeToggle class="md:hidden" />
        </header>

        <div class="mx-auto w-full max-w-5xl flex-1 px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-4 md:px-6 md:py-6">
          {props.children}
        </div>
      </SidebarInset>

      <Toaster theme={colorMode()} richColors closeButton />
    </SidebarProvider>
  );
};

export default AppShell;
