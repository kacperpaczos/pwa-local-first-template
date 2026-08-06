import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { useStore } from "@nanostores/solid";
import { useLiveQuery } from "@tanstack/solid-db";
import { RefreshCw, Sparkles, Tags, Trash2 } from "lucide-solid";
import {
  aiStatusStore,
  suggestMetaWithAi,
  summarizeWithAi,
  type SuggestedMeta,
} from "@/ai";
import { useDb } from "@/shared/db/DbProvider";
import type { Note } from "@/shared/db/schemas";
import { listConflicts } from "@/shared/sync/conflict-log";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TextField,
  TextFieldLabel,
  TextFieldInput,
  TextFieldTextArea,
} from "@/components/ui/text-field";
import { Separator } from "@/components/ui/separator";
import {
  notesFilterStore,
  notesFormErrorStore,
  setNotesFilter,
  setNotesFormError,
} from "./notes.store";

const SUMMARY_SEPARATOR = "\n\n---\nSummary:\n";

function friendlyNoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reading ['"]memory['"]/i.test(message) || /out of memory|oom/i.test(message)) {
    return "Could not save the note (browser memory pressure). Unload the AI model on the AI page, then try again.";
  }
  return message;
}

const NotesPage: Component = () => {
  const { db, facade } = useDb();
  const filter = useStore(notesFilterStore);
  const formError = useStore(notesFormErrorStore);
  const aiStatus = useStore(aiStatusStore);

  const notesQuery = useLiveQuery((q) =>
    q.from({ note: db.notes }).orderBy(({ note }) => note.updated_at, "desc"),
  );

  const visibleNotes = createMemo(() => {
    const rows = (notesQuery() ?? []) as Note[];
    if (filter() === "all") return rows;
    return rows.filter((note) => note.deleted_at == null);
  });

  const aiReady = createMemo(() => {
    const kind = aiStatus().kind;
    return kind === "ready" || kind === "busy";
  });

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [aiPending, setAiPending] = createSignal(false);
  const [suggestedMeta, setSuggestedMeta] = createSignal<SuggestedMeta | null>(null);
  const [conflictTick, setConflictTick] = createSignal(0);

  const selectedNote = createMemo(() => {
    const id = selectedId();
    if (!id) return undefined;
    return visibleNotes().find((note) => note.id === id);
  });

  const selectedConflicts = createMemo(() => {
    conflictTick();
    const id = selectedId();
    if (!id) return [];
    return listConflicts({ noteId: id });
  });

  const noteHasConflict = (noteId: string) => {
    conflictTick();
    return listConflicts({ noteId }).length > 0;
  };

  let titleInput!: HTMLInputElement;
  let bodyInput!: HTMLTextAreaElement;

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    setNotesFormError(null);
    try {
      await facade.createNote({
        title: titleInput.value,
        body: bodyInput.value,
      });
      titleInput.value = "";
      bodyInput.value = "";
    } catch (error) {
      setNotesFormError(friendlyNoteError(error));
    }
  };

  const onDelete = async (id: string) => {
    setNotesFormError(null);
    try {
      await facade.softDeleteNote(id);
      if (selectedId() === id) {
        setSelectedId(null);
        setSuggestedMeta(null);
      }
    } catch (error) {
      setNotesFormError(friendlyNoteError(error));
    }
  };

  const onSelectNote = (note: Note) => {
    if (note.deleted_at) return;
    setSelectedId(note.id);
    setSuggestedMeta(null);
    setNotesFormError(null);
    setConflictTick((n) => n + 1);
  };

  const onSummarizeNote = async () => {
    const note = selectedNote();
    if (!note?.body?.trim()) return;
    setNotesFormError(null);
    setAiPending(true);
    try {
      const summary = await summarizeWithAi(note.body);
      const nextBody = `${note.body}${SUMMARY_SEPARATOR}${summary.trim()}`;
      await facade.updateNote(note.id, { body: nextBody });
    } catch (error) {
      setNotesFormError(friendlyNoteError(error));
    } finally {
      setAiPending(false);
    }
  };

  const onSuggestMeta = async () => {
    const note = selectedNote();
    if (!note) return;
    const source = note.body?.trim() || note.title;
    if (!source) return;
    setNotesFormError(null);
    setSuggestedMeta(null);
    setAiPending(true);
    try {
      const meta = await suggestMetaWithAi(source);
      setSuggestedMeta(meta);
    } catch (error) {
      setNotesFormError(friendlyNoteError(error));
    } finally {
      setAiPending(false);
    }
  };

  const onAcceptMeta = async () => {
    const note = selectedNote();
    const meta = suggestedMeta();
    if (!note || !meta) return;
    setNotesFormError(null);
    setAiPending(true);
    try {
      await facade.updateNote(note.id, { title: meta.title });
      setSuggestedMeta(null);
    } catch (error) {
      setNotesFormError(friendlyNoteError(error));
    } finally {
      setAiPending(false);
    }
  };

  return (
    <div class="space-y-4 md:space-y-6">
      <PageHeader
        title="Notes"
        description={`filter: ${filter()}`}
        data-testid="sync-status"
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="sync-now"
            onClick={() => {
              void db.pullRemote().catch((error) => {
                setNotesFormError(friendlyNoteError(error));
              });
            }}
          >
            <RefreshCw class="size-4" />
            Sync now
          </Button>
        }
      />

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-6">
        <Card class="order-1">
          <CardHeader>
            <CardTitle>Add note</CardTitle>
            <CardDescription>Saved locally first, then synced through the outbox.</CardDescription>
          </CardHeader>
          <form onSubmit={onSubmit}>
            <CardContent class="space-y-4">
              <TextField>
                <TextFieldLabel>Title</TextFieldLabel>
                <TextFieldInput
                  ref={titleInput}
                  name="title"
                  placeholder="Title"
                  required
                  data-testid="note-title"
                />
              </TextField>
              <TextField>
                <TextFieldLabel>Body</TextFieldLabel>
                <TextFieldTextArea
                  ref={bodyInput}
                  name="body"
                  placeholder="Body (optional)"
                  data-testid="note-body"
                  class="min-h-28"
                />
              </TextField>
              <Show when={formError()}>
                {(message) => (
                  <Alert variant="destructive" data-testid="note-error">
                    <AlertTitle>Could not save</AlertTitle>
                    <AlertDescription>{message()}</AlertDescription>
                  </Alert>
                )}
              </Show>
            </CardContent>
            <Separator />
            <CardFooter class="pt-4">
              <Button type="submit" class="w-full sm:w-auto" data-testid="note-submit">
                Add note
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card class="order-2 lg:order-none lg:row-span-1" data-testid="notes-menu">
          <CardHeader class="pb-3">
            <CardTitle class="text-base">Your notes</CardTitle>
            <CardDescription>Filter and browse local notes.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex gap-2">
              <Button
                size="sm"
                class="flex-1 sm:flex-none"
                variant={filter() === "active" ? "default" : "outline"}
                data-testid="filter-active"
                onClick={() => setNotesFilter("active")}
              >
                Active
              </Button>
              <Button
                size="sm"
                class="flex-1 sm:flex-none"
                variant={filter() === "all" ? "default" : "outline"}
                data-testid="filter-all"
                onClick={() => setNotesFilter("all")}
              >
                All
              </Button>
            </div>

            <Show when={selectedNote() && selectedConflicts().length > 0}>
              <div
                class="flex items-center gap-2 rounded-md border border-warning-foreground/30 bg-warning/10 px-3 py-2"
                data-testid="note-conflict-badge"
              >
                <Badge variant="warning">Conflict</Badge>
                <p class="text-xs text-muted-foreground">
                  {selectedConflicts().length} sync conflict
                  {selectedConflicts().length === 1 ? "" : "s"} — see Settings → Conflict history
                </p>
              </div>
            </Show>

            <Show when={aiReady() && selectedNote()}>
              {(note) => (
                <div class="space-y-2 rounded-md border bg-muted/20 p-3" data-testid="note-ai-actions">
                  <p class="text-xs text-muted-foreground">
                    Selected: <span class="font-medium text-foreground">{note().title}</span>
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="note-summarize"
                      disabled={aiPending() || aiStatus().kind === "busy" || !note().body?.trim()}
                      onClick={() => void onSummarizeNote()}
                    >
                      <Sparkles class="size-4" />
                      Summarize
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="note-suggest-meta"
                      disabled={aiPending() || aiStatus().kind === "busy"}
                      onClick={() => void onSuggestMeta()}
                    >
                      <Tags class="size-4" />
                      Suggest title
                    </Button>
                  </div>
                  <Show when={suggestedMeta()}>
                    {(meta) => (
                      <div
                        class="space-y-2 rounded-md border bg-background p-3"
                        data-testid="note-suggested-meta"
                      >
                        <p class="text-sm">
                          <span class="font-medium">Proposed title:</span> {meta().title}
                        </p>
                        <Show when={meta().tags.length > 0}>
                          <p class="text-sm text-muted-foreground">
                            Tags: {meta().tags.join(", ")}
                          </p>
                        </Show>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            data-testid="note-accept-meta"
                            disabled={aiPending()}
                            onClick={() => void onAcceptMeta()}
                          >
                            Accept title
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid="note-dismiss-meta"
                            disabled={aiPending()}
                            onClick={() => setSuggestedMeta(null)}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            <Show
              when={!notesQuery.isLoading}
              fallback={<p class="text-sm text-muted-foreground">Loading…</p>}
            >
              <Show
                when={visibleNotes().length > 0}
                fallback={
                  <p class="text-sm text-muted-foreground" data-testid="notes-empty">
                    No notes.
                  </p>
                }
              >
                <ul class="space-y-3" data-testid="notes-list">
                  <For each={visibleNotes()}>
                    {(note) => (
                      <li
                        class="rounded-lg border border-border bg-muted/30 p-3"
                        classList={{
                          "ring-2 ring-ring": selectedId() === note.id && !note.deleted_at,
                          "cursor-pointer": !note.deleted_at,
                        }}
                        data-testid="note-item"
                        onClick={() => onSelectNote(note)}
                      >
                        <div class="mb-1 flex items-start justify-between gap-2">
                          <h3 class="font-medium leading-snug">
                            {note.title}
                            <Show when={note.deleted_at}>
                              <span class="text-muted-foreground"> (deleted)</span>
                            </Show>
                            <Show when={noteHasConflict(note.id)}>
                              <Badge
                                variant="warning"
                                class="ml-2 align-middle"
                                data-testid="note-item-conflict"
                              >
                                Conflict
                              </Badge>
                            </Show>
                          </h3>
                          <Show when={!note.deleted_at}>
                            <Button
                              size="icon"
                              variant="ghost"
                              class="size-8 shrink-0"
                              data-testid="note-delete"
                              aria-label="Delete note"
                              onClick={(event) => {
                                event.stopPropagation();
                                void onDelete(note.id);
                              }}
                            >
                              <Trash2 class="size-4" />
                            </Button>
                          </Show>
                        </div>
                        <Show when={note.body}>
                          <p class="whitespace-pre-wrap text-sm text-muted-foreground">{note.body}</p>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default NotesPage;
