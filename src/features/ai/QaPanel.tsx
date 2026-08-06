import { Show, type Component } from "solid-js";
import type { AiStatus } from "@/ai";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";

type QaPanelProps = {
  pending: () => boolean;
  status: () => AiStatus;
  input: () => string;
  setInput: (value: string) => void;
  onAsk: () => void;
  ragAnswer: () => string;
  activeNotesCount: () => number;
};

const QaPanel: Component<QaPanelProps> = (props) => {
  return (
    <>
      <p class="text-sm text-muted-foreground" data-testid="ai-qa-notes-count">
        Answers from your {props.activeNotesCount()} local note
        {props.activeNotesCount() === 1 ? "" : "s"} (embeddings stay on-device).
      </p>
      <TextField>
        <TextFieldLabel>Question</TextFieldLabel>
        <TextFieldTextArea
          data-testid="ai-qa-input"
          rows={3}
          placeholder="Ask about your notes"
          value={props.input()}
          onInput={(e) => props.setInput(e.currentTarget.value)}
          disabled={props.pending() || props.status().kind === "busy"}
        />
      </TextField>
      <Button
        class="w-full sm:w-auto"
        data-testid="ai-qa-ask"
        disabled={
          props.pending() ||
          !props.input().trim() ||
          props.status().kind === "busy" ||
          props.activeNotesCount() === 0
        }
        onClick={() => props.onAsk()}
      >
        Ask notes
      </Button>
      <Show when={props.ragAnswer()}>
        <p class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm" data-testid="ai-qa-output">
          {props.ragAnswer()}
        </p>
      </Show>
    </>
  );
};

export default QaPanel;
