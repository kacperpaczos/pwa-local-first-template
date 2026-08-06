import { createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { useLiveQuery } from "@tanstack/solid-db";
import { Bot, HelpCircle, MessageSquare, Sparkles } from "lucide-solid";
import {
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
import { createAsyncAction } from "@/shared/lib/async-action";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ModelPanel from "./ModelPanel";
import ChatPanel, { type ChatTurn } from "./ChatPanel";
import SummarizePanel from "./SummarizePanel";
import QaPanel from "./QaPanel";
import AgentPanel from "./AgentPanel";

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
      return status.reason === "no-webgpu" ? "unavailable (WebGPU required)" : "unavailable";
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
  const [selectedTier, setSelectedTier] = createSignal<AiTier>(getPersistedAiTier() ?? "std");
  const [hwReady, setHwReady] = createSignal(false);
  const activeModelId = createMemo(() => resolveAiModelId(selectedTier()));
  const activeModelSize = createMemo(() => sizeLabel(resolveAiModelApproxBytes(selectedTier())));
  const forcingAboveRecommend = createMemo(() => {
    const order: AiTier[] = ["dev", "std", "max"];
    return order.indexOf(selectedTier()) > order.indexOf(recommendedTier());
  });

  const skills = listSkills().filter((s) => s.enabled);
  const [skillId, setSkillId] = createSignal(skills[0]?.id ?? "strict-qa");
  const selectedSkill = createMemo((): Skill | undefined => skills.find((s) => s.id === skillId()) ?? skills[0]);

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

  const onDownload = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const controller = new AbortController();
      setDownloadAbort(controller);
      try {
        await downloadAiModel(controller.signal, selectedTier());
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
      } finally {
        setDownloadAbort(null);
      }
    },
    friendlyError,
  );

  const onCancelDownload = () => {
    downloadAbort()?.abort();
  };

  const onUnload = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      await unloadAiModel();
      setSummary("");
      setRagAnswer("");
      setAgentAnswer("");
      setPendingWrite(null);
    },
    friendlyError,
  );

  const onClearCache = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const result = await clearAiModelCache();
      setCacheMessage(result.detail);
      if (!result.cleared) {
        setActionError(result.detail);
      }
    },
    friendlyError,
  );

  const onChat = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const question = input().trim();
      if (!question) return;
      setInput("");
      setTurns((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: "" }]);
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
    },
    friendlyError,
  );

  const onSummarize = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      setSummary("");
      const text = await summarizeWithAi(input(), (chunk) => {
        setSummary((prev) => prev + chunk);
      });
      setSummary(text);
    },
    friendlyError,
  );

  const onAskNotes = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const question = input().trim();
      if (!question) return;
      setRagAnswer("");
      const notes = activeNotes().map((n) => ({ id: n.id, title: n.title, body: n.body }));
      const text = await answerWithRag(question, notes, (chunk) => {
        setRagAnswer((prev) => prev + chunk);
      });
      setRagAnswer(text);
    },
    friendlyError,
  );

  const onAgentRun = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const question = input().trim();
      if (!question) return;
      setAgentAnswer("");
      setPendingWrite(null);
      const notes = activeNotes().map((n) => ({ id: n.id, title: n.title, body: n.body }));
      const result = await runAgentTurn({
        question,
        notes,
        provider: getAiProvider(),
        skill: selectedSkill(),
      });
      setAgentAnswer(result.answer);
      setPendingWrite(result.pendingWrite ?? null);
    },
    friendlyError,
  );

  const onConfirmWrite = createAsyncAction(
    setPending,
    setActionError,
    async () => {
      const pw = pendingWrite();
      if (!pw) return;
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
    },
    friendlyError,
  );

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
            <AlertDescription>On-device AI needs WebGPU. Notes still work without it.</AlertDescription>
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
            <ModelPanel
              status={status}
              hwReady={hwReady}
              recommendedTier={recommendedTier}
              selectedTier={selectedTier}
              onTierChange={onTierChange}
              forcingAboveRecommend={forcingAboveRecommend}
              canLoad={canLoad}
              activeModelId={activeModelId}
              activeModelSize={activeModelSize}
              lowStorage={lowStorage}
              pending={pending}
              onDownload={() => void onDownload()}
              loadLabel={loadLabel}
              downloading={downloading}
              onCancelDownload={onCancelDownload}
              modelReady={modelReady}
              onUnload={() => void onUnload()}
              onClearCache={() => void onClearCache()}
              telemetry={telemetry}
              cacheMessage={cacheMessage}
            />

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
                  <ChatPanel
                    turns={turns}
                    pending={pending}
                    status={status}
                    input={input}
                    setInput={setInput}
                    onSend={() => void onChat()}
                  />
                </TabsContent>

                <TabsContent value="summarize" class="space-y-3">
                  <SummarizePanel
                    pending={pending}
                    status={status}
                    input={input}
                    setInput={setInput}
                    onSummarize={() => void onSummarize()}
                    summary={summary}
                  />
                </TabsContent>

                <TabsContent value="qa" class="space-y-3">
                  <QaPanel
                    pending={pending}
                    status={status}
                    input={input}
                    setInput={setInput}
                    onAsk={() => void onAskNotes()}
                    ragAnswer={ragAnswer}
                    activeNotesCount={() => activeNotes().length}
                  />
                </TabsContent>

                <TabsContent value="agent" class="space-y-3">
                  <AgentPanel
                    pending={pending}
                    status={status}
                    input={input}
                    setInput={setInput}
                    skills={skills}
                    skillId={skillId}
                    setSkillId={setSkillId}
                    selectedSkill={selectedSkill}
                    onRun={() => void onAgentRun()}
                    agentAnswer={agentAnswer}
                    pendingWrite={pendingWrite}
                    onConfirmWrite={() => void onConfirmWrite()}
                    onCancelWrite={onCancelWrite}
                  />
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
            Unload frees GPU RAM. Cached weights stay on disk for the next Load. Clear cache removes
            downloaded weights; if that fails, clear this site&apos;s data in browser settings.
          </CardFooter>
        </Card>
      </Show>
    </div>
  );
};

export default AiPage;
