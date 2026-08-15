import { For, Show, type Component } from "solid-js";
import { Download, Eraser, Loader2, Trash2, X } from "lucide-solid";
import { AI_TIER_MODELS, type AiStatus, type AiTelemetry, type AiTier } from "@/ai";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type DownloadingStatus = Extract<AiStatus, { kind: "downloading" }>;

type ModelPanelProps = {
  status: () => AiStatus;
  hwReady: () => boolean;
  recommendedTier: () => AiTier;
  selectedTier: () => AiTier;
  onTierChange: (tier: AiTier) => void;
  forcingAboveRecommend: () => boolean;
  canLoad: () => boolean;
  activeModelId: () => string;
  activeModelSize: () => string;
  lowStorage: () => boolean;
  pending: () => boolean;
  onDownload: () => void;
  loadLabel: () => string;
  downloading: () => DownloadingStatus | undefined;
  onCancelDownload: () => void;
  modelReady: () => boolean;
  onUnload: () => void;
  onClearCache: () => void;
  telemetry: () => AiTelemetry;
  cacheMessage: () => string | null;
};

const ModelPanel: Component<ModelPanelProps> = (props) => {
  return (
    <>
      <div class="space-y-3 rounded-md border bg-muted/20 p-3 text-sm" data-testid="ai-tier-panel">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium">Hardware tier</span>
          <Show when={props.hwReady()}>
            <Badge variant="outline" data-testid="ai-tier-recommended">
              Recommended: {AI_TIER_MODELS[props.recommendedTier()].label}
            </Badge>
          </Show>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-testid="ai-tier-select">
          <For each={["max", "std", "dev"] as AiTier[]}>
            {(tier) => (
              <Button
                size="sm"
                variant={props.selectedTier() === tier ? "default" : "outline"}
                data-testid={`ai-tier-${tier}`}
                disabled={
                  props.pending() ||
                  props.status().kind === "busy" ||
                  props.status().kind === "downloading"
                }
                onClick={() => props.onTierChange(tier)}
              >
                {AI_TIER_MODELS[tier].label}
                <Show when={tier === props.recommendedTier()}>
                  <span class="ml-1 text-xs opacity-70">(rec.)</span>
                </Show>
              </Button>
            )}
          </For>
        </div>
        <Show when={props.forcingAboveRecommend()}>
          <Alert data-testid="ai-tier-warning">
            <AlertTitle>Override</AlertTitle>
            <AlertDescription>
              {AI_TIER_MODELS[props.selectedTier()].label} may fail to load on this device. Prefer{" "}
              {AI_TIER_MODELS[props.recommendedTier()].label} if download or inference crashes.
            </AlertDescription>
          </Alert>
        </Show>
      </div>

      <Show when={props.canLoad()}>
        <div class="space-y-2 rounded-md border bg-muted/20 p-3 text-sm" data-testid="ai-consent">
          <p>
            <span class="font-medium">Model:</span>{" "}
            <code class="text-xs" data-testid="ai-model-id">
              {props.activeModelId()}
            </code>
          </p>
          <p data-testid="ai-model-size">
            <span class="font-medium">Approximate size:</span> {props.activeModelSize()}
          </p>
          <p class="text-muted-foreground" data-testid="ai-privacy-note">
            Runs offline — your notes and prompts stay on this device.
          </p>
          <Show when={props.lowStorage()}>
            <Alert variant="destructive" data-testid="ai-storage-warning">
              <AlertTitle>Low storage</AlertTitle>
              <AlertDescription>
                This browser may not have enough free space for a {props.activeModelSize()}{" "}
                download. Free some space, or continue if you know the model is already cached.
              </AlertDescription>
            </Alert>
          </Show>
        </div>
      </Show>

      <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Show when={props.canLoad()}>
          <Button
            class="w-full sm:w-auto"
            data-testid="ai-download"
            disabled={props.pending()}
            onClick={() => props.onDownload()}
          >
            <Show when={props.pending()} fallback={<Download class="size-4" />}>
              <Loader2 class="size-4 animate-spin" />
            </Show>
            {props.loadLabel()}
          </Button>
        </Show>
        <Show when={props.downloading()}>
          <Button
            class="w-full sm:w-auto"
            variant="outline"
            data-testid="ai-download-cancel"
            onClick={props.onCancelDownload}
          >
            <X class="size-4" />
            Cancel
          </Button>
        </Show>
        <Show when={props.modelReady() || props.status().kind === "error"}>
          <Button
            class="w-full sm:w-auto"
            variant="outline"
            data-testid="ai-unload"
            disabled={props.pending() || props.status().kind === "busy"}
            onClick={() => props.onUnload()}
          >
            <Trash2 class="size-4" />
            Unload model
          </Button>
        </Show>
        <Button
          class="w-full sm:w-auto"
          variant="outline"
          data-testid="ai-clear-cache"
          disabled={
            props.pending() ||
            props.status().kind === "busy" ||
            props.status().kind === "downloading"
          }
          onClick={() => props.onClearCache()}
        >
          <Eraser class="size-4" />
          Clear model cache
        </Button>
      </div>

      <Show
        when={(() => {
          const s = props.status();
          return s.kind === "available" && s.cached ? s : undefined;
        })()}
      >
        <p class="text-sm text-muted-foreground">
          Weights are already saved in this browser. Load only puts them into GPU memory for this
          session.
        </p>
      </Show>

      <Show when={props.downloading()}>
        {(s) => (
          <Progress value={Math.round(s().progress * 100)} data-testid="ai-download-progress" />
        )}
      </Show>

      <div class="rounded-md border bg-muted/20 p-3 text-sm" data-testid="ai-telemetry">
        <p class="font-medium">Local telemetry</p>
        <p class="text-muted-foreground">
          Inferences: {props.telemetry().inferCount} · Errors: {props.telemetry().errorCount} ·
          Last: {props.telemetry().lastMs == null ? "—" : `${props.telemetry().lastMs} ms`}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          Model unloads from GPU after 10 minutes of inactivity. Cached weights stay on disk until
          you clear the cache.
        </p>
      </div>

      <Show when={props.cacheMessage()}>
        <Alert data-testid="ai-cache-message">
          <AlertDescription>{props.cacheMessage()}</AlertDescription>
        </Alert>
      </Show>
    </>
  );
};

export default ModelPanel;
