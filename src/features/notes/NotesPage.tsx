import { For, Show, createMemo, type Component } from "solid-js";
import { A } from "@solidjs/router";
import { useStore } from "@nanostores/solid";
import { useLiveQuery } from "@tanstack/solid-db";
import { useDb } from "@/shared/db/DbProvider";
import type { Note } from "@/shared/db/schemas";
import {
  notesFilterStore,
  notesFormErrorStore,
  setNotesFilter,
  setNotesFormError,
  syncStatusStore,
} from "./notes.store";
import styles from "./notes.module.css";

const NotesPage: Component = () => {
  const { db, facade } = useDb();
  const filter = useStore(notesFilterStore);
  const formError = useStore(notesFormErrorStore);
  const syncStatus = useStore(syncStatusStore);

  const notesQuery = useLiveQuery((q) =>
    q.from({ note: db.notes }).orderBy(({ note }) => note.updated_at, "desc"),
  );

  const visibleNotes = createMemo(() => {
    const rows = (notesQuery() ?? []) as Note[];
    if (filter() === "all") return rows;
    return rows.filter((note) => note.deleted_at == null);
  });

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
      setNotesFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const onDelete = async (id: string) => {
    setNotesFormError(null);
    try {
      await facade.softDeleteNote(id);
    } catch (error) {
      setNotesFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main class={styles.page}>
      <header class={styles.header}>
        <h1 class={styles.title}>Notatki</h1>
        <nav class={styles.nav}>
          <A href="/">Home</A>
        </nav>
      </header>

      <p class={styles.status} data-testid="sync-status">
        Sync: {syncStatus()} · filtr: {filter()}
      </p>
      <div class={styles.actions} style={{ "margin-bottom": "1rem" }}>
        <button
          type="button"
          class={styles.buttonGhost}
          data-testid="sync-now"
          onClick={() => {
            void db.pullRemote().catch((error) => {
              setNotesFormError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          Synchronizuj
        </button>
      </div>

      <form class={styles.form} onSubmit={onSubmit}>
        <input
          ref={titleInput}
          class={styles.input}
          name="title"
          placeholder="Tytuł"
          required
          data-testid="note-title"
        />
        <textarea
          ref={bodyInput}
          class={styles.textarea}
          name="body"
          placeholder="Treść (opcjonalnie)"
          data-testid="note-body"
        />
        <div class={styles.actions}>
          <button class={styles.button} type="submit" data-testid="note-submit">
            Dodaj notatkę
          </button>
        </div>
        <Show when={formError()}>
          {(message) => (
            <p class={styles.error} data-testid="note-error">
              {message()}
            </p>
          )}
        </Show>
      </form>

      <div class={styles.filters}>
        <button
          type="button"
          classList={{ [styles.filterActive]: filter() === "active" }}
          onClick={() => setNotesFilter("active")}
        >
          Aktywne
        </button>
        <button
          type="button"
          classList={{ [styles.filterActive]: filter() === "all" }}
          onClick={() => setNotesFilter("all")}
        >
          Wszystkie
        </button>
      </div>

      <Show when={!notesQuery.isLoading} fallback={<p class={styles.empty}>Ładowanie…</p>}>
        <Show
          when={visibleNotes().length > 0}
          fallback={
            <p class={styles.empty} data-testid="notes-empty">
              Brak notatek.
            </p>
          }
        >
          <ul class={styles.list} data-testid="notes-list">
            <For each={visibleNotes()}>
              {(note) => (
                <li class={styles.item} data-testid="note-item">
                  <h2 class={styles.itemTitle}>
                    {note.title}
                    <Show when={note.deleted_at}>
                      <span> (usunięta)</span>
                    </Show>
                  </h2>
                  <Show when={note.body}>
                    <p class={styles.itemBody}>{note.body}</p>
                  </Show>
                  <Show when={!note.deleted_at}>
                    <button
                      type="button"
                      class={styles.buttonGhost}
                      data-testid="note-delete"
                      onClick={() => void onDelete(note.id)}
                    >
                      Usuń
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </main>
  );
};

export default NotesPage;
