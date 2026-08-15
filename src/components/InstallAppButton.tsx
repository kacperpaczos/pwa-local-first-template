import { Show, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { Download } from "lucide-solid";
import { Button } from "@/components/ui/button";
import { installPromptStore, installedStore, promptInstall } from "@/shared/lib/install-prompt";

const InstallAppButton: Component<{ class?: string }> = (props) => {
  const prompt = useStore(installPromptStore);
  const installed = useStore(installedStore);

  return (
    <Show when={!installed() && prompt()}>
      <Button
        size="sm"
        variant="outline"
        class={props.class}
        data-testid="install-app"
        onClick={() => void promptInstall()}
      >
        <Download class="size-4" />
        Install app
      </Button>
    </Show>
  );
};

export default InstallAppButton;
