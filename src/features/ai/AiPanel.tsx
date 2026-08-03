import { Show, createMemo, createSignal, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import {
  aiStatusStore,
  downloadAiModel,
  summarizeWithAi,
  type AiStatus,
} from "@/ai";

function label(status: AiStatus): string {
  switch (status.kind) {
    case "available":
      return "dostępne (model niepobrany)";
    case "downloading":
      return `pobieranie modelu… ${Math.round(status.progress * 100)}%`;
    case "ready":
      return "model gotowy";
    case "busy":
      return "przetwarzanie…";
    case "error":
      return `błąd: ${status.reason}`;
    case "unavailable":
      return "niedostępne";
  }
}

const AiPanel: Component = () => {
  const status = useStore(aiStatusStore);
  const downloading = createMemo(() => {
    const s = status();
    return s.kind === "downloading" ? s : undefined;
  });
  const modelReady = createMemo(() => {
    const kind = status().kind;
    return kind === "ready" || kind === "busy";
  });
  const [summary, setSummary] = createSignal("");
  const [input, setInput] = createSignal("");
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const onDownload = async () => {
    setActionError(null);
    setPending(true);
    try {
      await downloadAiModel();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  const onSummarize = async () => {
    setActionError(null);
    setSummary("");
    setPending(true);
    try {
      const text = await summarizeWithAi(input(), (chunk) => {
        setSummary((prev) => prev + chunk);
      });
      setSummary(text);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Show when={status().kind !== "unavailable"}>
      <div data-testid="ai-panel" style={{ "margin-bottom": "1rem" }}>
        <p data-testid="ai-status">AI: {label(status())}</p>

        <Show when={status().kind === "available" || status().kind === "error"}>
          <button
            type="button"
            data-testid="ai-download"
            disabled={pending()}
            onClick={() => void onDownload()}
          >
            Pobierz model
          </button>
        </Show>

        <Show when={downloading()}>
          {(s) => <progress data-testid="ai-download-progress" max={1} value={s().progress} />}
        </Show>

        <Show when={modelReady()}>
          <div style={{ display: "grid", gap: "0.5rem", "margin-top": "0.5rem" }}>
            <textarea
              data-testid="ai-summarize-input"
              rows={3}
              placeholder="Tekst do streszczenia"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              disabled={pending() || status().kind === "busy"}
            />
            <button
              type="button"
              data-testid="ai-summarize"
              disabled={pending() || !input().trim() || status().kind === "busy"}
              onClick={() => void onSummarize()}
            >
              Streszcz
            </button>
            <Show when={summary()}>
              <p data-testid="ai-summary-output">{summary()}</p>
            </Show>
          </div>
        </Show>

        <Show when={actionError()}>
          <p data-testid="ai-action-error">{actionError()}</p>
        </Show>
      </div>
    </Show>
  );
};

export default AiPanel;
