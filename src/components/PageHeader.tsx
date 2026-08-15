import type { Component, JSX, ParentProps } from "solid-js";
import { Show } from "solid-js";
import { cn } from "@/lib/utils";

type PageHeaderProps = ParentProps<{
  title: string;
  description?: string;
  class?: string;
  actions?: JSX.Element;
  "data-testid"?: string;
}>;

const PageHeader: Component<PageHeaderProps> = (props) => {
  return (
    <div
      class={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        props.class,
      )}
    >
      <div class="min-w-0 space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{props.title}</h1>
        <Show when={props.description}>
          <p class="text-sm text-muted-foreground" data-testid={props["data-testid"]}>
            {props.description}
          </p>
        </Show>
        {props.children}
      </div>
      <Show when={props.actions}>
        <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
      </Show>
    </div>
  );
};

export default PageHeader;
