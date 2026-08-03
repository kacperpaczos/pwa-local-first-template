import type { Component } from "solid-js";
import { useColorMode } from "@kobalte/core";
import { Laptop, Moon, Sun } from "lucide-solid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const ModeToggle: Component<{ class?: string }> = (props) => {
  const { setColorMode } = useColorMode();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button<"button">}
        variant="ghost"
        size="icon"
        class={cn("relative", props.class)}
        aria-label="Toggle theme"
      >
        <Sun class="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon class="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span class="sr-only">Toggle theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem class="gap-2" onSelect={() => setColorMode("light")}>
          <Sun class="size-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem class="gap-2" onSelect={() => setColorMode("dark")}>
          <Moon class="size-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem class="gap-2" onSelect={() => setColorMode("system")}>
          <Laptop class="size-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ModeToggle;
