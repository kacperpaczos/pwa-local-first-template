import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { useLiveQuery } from "@tanstack/solid-db";
import {
  Bot,
  Download,
  Eraser,
  HelpCircle,
  Loader2,
  MessageSquare,
  Sparkles,
  Trash2,
  X,
} from "lucide-solid";
import {
  AI_TIER_MODELS,
  detectHardware,
  downloadAiModel,
  getAiProvider,
  getPersistedAiTier,
  listSkills,
  recommendTier,
  resolveAiModelId,
  resolveAiModelApproxBytes,
  runAgentTurn,
  setPersistedAiTier,
  aiStatusStore,
  aiStorageHeadroomStore,
  aiTelemetryStore,
  answerWithRag,
  chatWithAi,
  clearAiModelCache,
  refreshAiCacheStatus,
  summarizeWithAi,
  unloadAiModel,
  type AiStatus,
  type AiTier,
  type PendingWrite,
  type Skill,
} from "@/ai";
import { useDb } from "@/shared/db/DbProvider";
import type { Note } from "@/shared/db/schemas";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "@/components/ui/text-field";

type ChatTurn = { role: "user" | "assistant"; text: string };

function label(status: AiStatus): string {
  switch (status.kind) {
    case "available":
      return status.cached
        ? "available (cached on disk — click Load)"
        : "available (model not downloaded)";
    case "downloading":
      return status.fromCache
        ? `loading model into GPU… ${Math.round(status.progress * 100)}%`
        : `downloading model… ${Math.round(status.progress * 100)}%`;
    case "ready":
      return "model ready in GPU";
    case "busy":
      return "processing…";
    case "error":
      return `error: ${status.reason}`;
    case "unavailable":
      return status.reason === "no-webgpu"
        ? "unavailable (WebGPU required)"
        : "unavailable";
  }
}

function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Download cancelled.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/reading ['"]memory['"]/i.test(message) || /out of memory|oom/i.test(message)) {
    return "Local AI ran out of memory. Unload the model, then try again or use a smaller prompt.";
  }
  return message;
}

function sizeLabel(bytes: number): string {
  return `~${Math.round(bytes / (1024 * 1024))} MB`;
}

const AiPage: Component = () => {
  const { db, facade } = useDb();
  const status = useStore(aiStatusStore);
  const headroom = useStore(aiStorageHeadroomStore);
  const telemetry = useStore(aiTelemetryStore);
  const notesQuery = useLiveQuery((q) =>
    q.from({ note: db.notes }).orderBy(({ note }) => note.updated_at, "desc"),
  );
  const activeNotes = createMemo(() => {
    const rows = (notesQuery() ?? []) as Note[];
    return rows.filter((note) => note.deleted_at == null);
  });
  const downloading = createMemo(() => {
    const s = status();
    return s.kind === "downloading" ? s : undefined;
  });
  const modelReady = createMemo(() => {
    const kind = status().kind;
    return kind === "ready" || kind === "busy";
  });
  const canLoad = createMemo(() => {
    const s = status();
    return s.kind === "available" || s.kind === "error";
  });
  const loadLabel = createMemo(() => {
    const s = status();
    return s.kind === "available" && s.cached ? "Load model" : "Download model";
  });
  const lowStorage = createMemo(() => {
    const h = headroom();
    return h != null && !h.ok;
  });

  const [recommendedTier, setRecommendedTier] = createSignal<AiTier>("std");
  const [selectedTier, setSelectedTier] = createSignal<AiTier>(
    getPersistedAiTier() ?? "std",
  );
  const [hwReady, setHwReady] = createSignal(false);
  const activeModelId = createMemo(() => resolveAiModelId(selectedTier()));
  const activeModelSize = createMemo(() =>
    sizeLabel(resolveAiModelApproxBytes(selectedTier())),
  );
  const forcingAboveRecommend = createMemo(() => {
    const order: AiTier[] = ["dev", "std", "max"];
    return order.indexOf(selectedTier()) > order.indexOf(recommendedTier());
  });

  const skills = listSkills().filter((s) => s.enabled);
  const [skillId, setSkillId] = createSignal(skills[0]?.id ?? "strict-qa");
  const selectedSkill = createMemo(
    (): Skill | undefined => skills.find((s) => s.id === skillId()) ?? skills[0],
  );

  const [input, setInput] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [ragAnswer, setRagAnswer] = createSignal("");
  const [agentAnswer, setAgentAnswer] = createSignal("");
  const [pendingWrite, setPendingWrite] = createSignal<PendingWrite | null>(null);
  const [turns, setTurns] = createSignal<ChatTurn[]>([]);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [cacheMessage, setCacheMessage] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [downloadAbort, setDownloadAbort] = createSignal<AbortController | null>(null);

  onMount(() => {
    void refreshAiCacheStatus(selectedTier());
    void (async () => {
      try {
        const profile = await detectHardware();
        const recommended = recommendTier(profile);
        setRecommendedTier(recommended);
        if (getPersistedAiTier() == null) {
          setSelectedTier(recommended);
        }
      } finally {
        setHwReady(true);
      }
    })();
  });

  onCleanup(() => {
    downloadAbort()?.abort();
  });

  const onTierChange = (tier: AiTier) => {
    setSelectedTier(tier);
    setPersistedAiTier(tier);
    void refreshAiCacheStatus(tier);
  };

  const onDownload = async () => {
    setActionError(null);
    const controller = new AbortController();
    setDownloadAbort(controller);
    setPending(true);
    try {
      await downloadAiModel(controller.signal, selectedTier());
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setActionError(friendlyError(error));
      }
    } finally {
      setDownloadAbort(null);
      setPending(false);
    }
  };

  const onCancelDownload = () => {
    downloadAbort()?.abort();
  };

  const onUnload = async () => {
    setActionError(null);
    setPending(true);
    try {
      await unloadAiModel();
      setSummary("");
      setRagAnswer("");
      setAgentAnswer("");
      setPendingWrite(null);
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onClearCache = async () => {
    setActionError(null);
    setCacheMessage(null);
    setPending(true);
    try {
      const result = await clearAiModelCache();
      setCacheMessage(result.detail);
      if (!result.cleared) {
        setActionError(result.detail);
      }
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onChat = async () => {
    const question = input().trim();
    if (!question) return;
    setActionError(null);
    setInput("");
    setTurns((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: "" }]);
    setPending(true);
    try {
      const text = await chatWithAi(question, (chunk) => {
        setTurns((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { role: "assistant", text: last.text + chunk };
          }
          return next;
        });
      });
      setTurns((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { role: "assistant", text };
        }
        return next;
      });
    } catch (error) {
      setActionError(friendlyError(error));
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
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onAskNotes = async () => {
    const question = input().trim();
    if (!question) return;
    setActionError(null);
    setRagAnswer("");
    setPending(true);
    try {
      const notes = activeNotes().map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
      }));
      const text = await answerWithRag(question, notes, (chunk) => {
        setRagAnswer((prev) => prev + chunk);
      });
      setRagAnswer(text);
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onAgentRun = async () => {
    const question = input().trim();
    if (!question) return;
    setActionError(null);
    setAgentAnswer("");
    setPendingWrite(null);
    setPending(true);
    try {
      const notes = activeNotes().map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
      }));
      const result = await runAgentTurn({
        question,
        notes,
        provider: getAiProvider(),
        skill: selectedSkill(),
      });
      setAgentAnswer(result.answer);
      setPendingWrite(result.pendingWrite ?? null);
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onConfirmWrite = async () => {
    const pw = pendingWrite();
    if (!pw) return;
    setActionError(null);
    setPending(true);
    try {
      if (pw.tool === "create_note") {
        const title = String(pw.args.title ?? "");
        const body = typeof pw.args.body === "string" ? pw.args.body : "";
        await facade.createNote({ title, body });
        setAgentAnswer((prev) => `${prev}\n\n✓ Note created.`);
      } else if (pw.tool === "update_note_title") {
        const noteId = String(pw.args.noteId ?? "");
        const title = String(pw.args.title ?? "");
        await facade.updateNote(noteId, { title });
        setAgentAnswer((prev) => `${prev}\n\n✓ Title updated.`);
      }
      setPendingWrite(null);
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setPending(false);
    }
  };

  const onCancelWrite = () => {
    setPendingWrite(null);
    setAgentAnswer((prev) => `${prev}\n\n(Write cancelled.)`);
  };

  return (
    <div class="mx-auto max-w-3xl space-y-4 md:space-y-6">
      <PageHeader
        title="AI"
        description="On-device WebLLM. Separate from notes so GPU memory does not block SQLite writes."
      />

      <Show
        when={status().kind !== "unavailable"}
        fallback={
          <Alert data-testid="ai-unavailable">
            <AlertTitle>AI unavailable</AlertTitle>
            <AlertDescription>
              On-device AI needs WebGPU. Notes still work without it.
            </AlertDescription>
          </Alert>
        }
      >
        <Card data-testid="ai-panel">
          <CardHeader class="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
            <div class="space-y-1">
              <CardTitle>Model</CardTitle>
              <CardDescription data-testid="ai-status">AI: {label(status())}</CardDescription>
            </div>
            <Badge variant="secondary" class="w-fit capitalize">
              {status().kind}
            </Badge>
          </CardHeader>
          <CardContent class="space-y-4">
            <div
              class="space-y-3 rounded-md border bg-muted/20 p-3 text-sm"
              data-testid="ai-tier-panel"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">Hardware tier</span>
                <Show when={hwReady()}>
                  <Badge variant="outline" data-testid="ai-tier-recommended">
                    Recommended: {AI_TIER_MODELS[recommendedTier()].label}
                  </Badge>
                </Show>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-testid="ai-tier-select">
                <For each={(["max", "std", "dev"] as AiTier[])}>
                  {(tier) => (
                    <Button
                      size="sm"
                      variant={selectedTier() === tier ? "default" : "outline"}
                      data-testid={`ai-tier-${tier}`}
                      disabled={pending() || status().kind === "busy" || status().kind === "downloading"}
                      onClick={() => onTierChange(tier)}
                    >
                      {AI_TIER_MODELS[tier].label}
                      <Show when={tier === recommendedTier()}>
                        <span class="ml-1 text-xs opacity-70">(rec.)</span>
                      </Show>
                    </Button>
                  )}
                </For>
              </div>
              <Show when={forcingAboveRecommend()}>
                <Alert data-testid="ai-tier-warning">
                  <AlertTitle>Override</AlertTitle>
                  <AlertDescription>
                    {AI_TIER_MODELS[selectedTier()].label} may fail to load on this device. Prefer{" "}
                    {AI_TIER_MODELS[recommendedTier()].label} if download or inference crashes.
                  </AlertDescription>
                </Alert>
              </Show>
            </div>

            <Show when={canLoad()}>
              <div
                class="space-y-2 rounded-md border bg-muted/20 p-3 text-sm"
                data-testid="ai-consent"
              >
                <p>
                  <span class="font-medium">Model:</span>{" "}
                  <code class="text-xs" data-testid="ai-model-id">
                    {activeModelId()}
                  </code>
                </p>
                <p data-testid="ai-model-size">
                  <span class="font-medium">Approximate size:</span> {activeModelSize()}
                </p>
                <p class="text-muted-foreground" data-testid="ai-privacy-note">
                  Runs offline — your notes and prompts stay on this device.
                </p>
                <Show when={lowStorage()}>
                  <Alert variant="destructive" data-testid="ai-storage-warning">
                    <AlertTitle>Low storage</AlertTitle>
                    <AlertDescription>
                      This browser may not have enough free space for a {activeModelSize()}{" "}
                      download. Free some space, or continue if you know the model is already
                      cached.
                    </AlertDescription>
                  </Alert>
                </Show>
              </div>
            </Show>

            <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Show when={canLoad()}>
                <Button
                  class="w-full sm:w-auto"
                  data-testid="ai-download"
                  disabled={pending()}
                  onClick={() => void onDownload()}
                >
                  <Show when={pending()} fallback={<Download class="size-4" />}>
                    <Loader2 class="size-4 animate-spin" />
                  </Show>
                  {loadLabel()}
                </Button>
              </Show>
              <Show when={downloading()}>
                <Button
                  class="w-full sm:w-auto"
                  variant="outline"
                  data-testid="ai-download-cancel"
                  onClick={onCancelDownload}
                >
                  <X class="size-4" />
                  Cancel
                </Button>
              </Show>
              <Show when={modelReady() || status().kind === "error"}>
                <Button
                  class="w-full sm:w-auto"
                  variant="outline"
                  data-testid="ai-unload"
                  disabled={pending() || status().kind === "busy"}
                  onClick={() => void onUnload()}
                >
                  <Trash2 class="size-4" />
                  Unload model
                </Button>
              </Show>
              <Button
                class="w-full sm:w-auto"
                variant="outline"
                data-testid="ai-clear-cache"
                disabled={pending() || status().kind === "busy" || status().kind === "downloading"}
                onClick={() => void onClearCache()}
              >
                <Eraser class="size-4" />
                Clear model cache
              </Button>
            </div>

            <Show
              when={(() => {
                const s = status();
                return s.kind === "available" && s.cached ? s : undefined;
              })()}
            >
              <p class="text-sm text-muted-foreground">
                Weights are already saved in this browser. Load only puts them into GPU memory for
                this session.
              </p>
            </Show>

            <Show when={downloading()}>
              {(s) => (
                <Progress value={Math.round(s().progress * 100)} data-testid="ai-download-progress" />
              )}
            </Show>

            <div
              class="rounded-md border bg-muted/20 p-3 text-sm"
              data-testid="ai-telemetry"
            >
              <p class="font-medium">Local telemetry</p>
              <p class="text-muted-foreground">
                Inferences: {telemetry().inferCount} · Errors: {telemetry().errorCount} · Last:{" "}
                {telemetry().lastMs == null ? "—" : `${telemetry().lastMs} ms`}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                Model unloads from GPU after 10 minutes of inactivity. Cached weights stay on disk
                until you clear the cache.
              </p>
            </div>

            <Show when={cacheMessage()}>
              <Alert data-testid="ai-cache-message">
                <AlertDescription>{cacheMessage()}</AlertDescription>
              </Alert>
            </Show>

            <Show when={modelReady()}>
              <Tabs defaultValue="chat">
                <TabsList class="grid w-full grid-cols-2 sm:grid-cols-4">
                  <TabsTrigger value="chat" data-testid="ai-mode-chat">
                    <MessageSquare class="size-4" />
                    Chat
                  </TabsTrigger>
                  <TabsTrigger value="summarize" data-testid="ai-mode-summarize">
                    <Sparkles class="size-4" />
                    Summarize
                  </TabsTrigger>
                  <TabsTrigger value="qa" data-testid="ai-mode-qa">
                    <HelpCircle class="size-4" />
                    Q&amp;A
                  </TabsTrigger>
                  <TabsTrigger value="agent" data-testid="ai-mode-agent">
                    <Bot class="size-4" />
                    Agent
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="chat" class="space-y-3">
                  <div
                    class="max-h-72 space-y-3 overflow-auto rounded-md border bg-muted/20 p-3"
                    data-testid="ai-chat-log"
                  >
                    <For each={turns()} fallback={<p class="text-sm text-muted-foreground">No messages yet.</p>}>
                      {(turn) => (
                        <div class="space-y-1">
                          <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {turn.role === "user" ? "You" : "AI"}
                          </p>
                          <p class="whitespace-pre-wrap text-sm">
                            {turn.text || (pending() ? "…" : "")}
                          </p>
                        </div>
                      )}
                    </For>
                  </div>
                  <TextField>
                    <TextFieldLabel>Message</TextFieldLabel>
                    <TextFieldTextArea
                      data-testid="ai-chat-input"
                      rows={3}
                      placeholder="Ask anything — replies in your language"
                      value={input()}
                      onInput={(e) => setInput(e.currentTarget.value)}
                      disabled={pending() || status().kind === "busy"}
                    />
                  </TextField>
                  <Button
                    class="w-full sm:w-auto"
                    data-testid="ai-chat-send"
                    disabled={pending() || !input().trim() || status().kind === "busy"}
                    onClick={() => void onChat()}
                  >
                    Send
                  </Button>
                </TabsContent>

                <TabsContent value="summarize" class="space-y-3">
                  <TextField>
                    <TextFieldLabel>Text to summarize</TextFieldLabel>
                    <TextFieldTextArea
                      data-testid="ai-summarize-input"
                      rows={5}
                      placeholder="Paste text to summarize"
                      value={input()}
                      onInput={(e) => setInput(e.currentTarget.value)}
                      disabled={pending() || status().kind === "busy"}
                    />
                  </TextField>
                  <Button
                    class="w-full sm:w-auto"
                    data-testid="ai-summarize"
                    disabled={pending() || !input().trim() || status().kind === "busy"}
                    onClick={() => void onSummarize()}
                  >
                    Summarize
                  </Button>
                  <Show when={summary()}>
                    <p
                      class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
                      data-testid="ai-summary-output"
                    >
                      {summary()}
                    </p>
                  </Show>
                </TabsContent>

                <TabsContent value="qa" class="space-y-3">
                  <p class="text-sm text-muted-foreground" data-testid="ai-qa-notes-count">
                    Answers from your {activeNotes().length} local note
                    {activeNotes().length === 1 ? "" : "s"} (embeddings stay on-device).
                  </p>
                  <TextField>
                    <TextFieldLabel>Question</TextFieldLabel>
                    <TextFieldTextArea
                      data-testid="ai-qa-input"
                      rows={3}
                      placeholder="Ask about your notes"
                      value={input()}
                      onInput={(e) => setInput(e.currentTarget.value)}
                      disabled={pending() || status().kind === "busy"}
                    />
                  </TextField>
                  <Button
                    class="w-full sm:w-auto"
                    data-testid="ai-qa-ask"
                    disabled={
                      pending() ||
                      !input().trim() ||
                      status().kind === "busy" ||
                      activeNotes().length === 0
                    }
                    onClick={() => void onAskNotes()}
                  >
                    Ask notes
                  </Button>
                  <Show when={ragAnswer()}>
                    <p
                      class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
                      data-testid="ai-qa-output"
                    >
                      {ragAnswer()}
                    </p>
                  </Show>
                </TabsContent>

                <TabsContent value="agent" class="space-y-3">
                  <p class="text-sm text-muted-foreground">
                    Local tool loop over your notes. Writes need confirmation.
                  </p>
                  <label class="block space-y-1 text-sm">
                    <span class="font-medium">Skill</span>
                    <select
                      class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      data-testid="ai-agent-skill"
                      value={skillId()}
                      onChange={(e) => setSkillId(e.currentTarget.value)}
                      disabled={pending() || status().kind === "busy"}
                    >
                      <For each={skills}>
                        {(skill) => <option value={skill.id}>{skill.name}</option>}
                      </For>
                    </select>
                  </label>
                  <Show when={selectedSkill()}>
                    {(skill) => (
                      <p class="text-xs text-muted-foreground">{skill().description}</p>
                    )}
                  </Show>
                  <TextField>
                    <TextFieldLabel>Task</TextFieldLabel>
                    <TextFieldTextArea
                      data-testid="ai-agent-input"
                      rows={3}
                      placeholder="e.g. Find notes about pasta and propose a summary note"
                      value={input()}
                      onInput={(e) => setInput(e.currentTarget.value)}
                      disabled={pending() || status().kind === "busy"}
                    />
                  </TextField>
                  <Button
                    class="w-full sm:w-auto"
                    data-testid="ai-agent-run"
                    disabled={pending() || !input().trim() || status().kind === "busy"}
                    onClick={() => void onAgentRun()}
                  >
                    Run agent
                  </Button>
                  <Show when={agentAnswer()}>
                    <p
                      class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
                      data-testid="ai-agent-output"
                    >
                      {agentAnswer()}
                    </p>
                  </Show>
                  <Show when={pendingWrite()}>
                    {(pw) => (
                      <Alert data-testid="ai-agent-confirm">
                        <AlertTitle>Confirm write</AlertTitle>
                        <AlertDescription class="space-y-3">
                          <p>{pw().summary}</p>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              data-testid="ai-agent-confirm-yes"
                              disabled={pending()}
                              onClick={() => void onConfirmWrite()}
                            >
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid="ai-agent-confirm-no"
                              disabled={pending()}
                              onClick={onCancelWrite}
                            >
                              Cancel
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}
                  </Show>
                </TabsContent>
              </Tabs>
            </Show>

            <Show when={actionError()}>
              <Alert variant="destructive" data-testid="ai-action-error">
                <AlertTitle>AI error</AlertTitle>
                <AlertDescription>{actionError()}</AlertDescription>
              </Alert>
            </Show>
          </CardContent>
          <Separator />
          <CardFooter class="text-xs text-muted-foreground">
            Unload frees GPU RAM. Cached weights stay on disk for the next Load. Clear cache
            removes downloaded weights; if that fails, clear this site&apos;s data in browser
            settings.
          </CardFooter>
        </Card>
      </Show>
    </div>
  );
};

export default AiPage;
