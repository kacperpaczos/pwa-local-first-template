import { Show, type Component } from "solid-js";
import type { AiStatus } from "@/ai";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";

type SummarizePanelProps = {
  pending: () => boolean;
  status: () => AiStatus;
  input: () => string;
  setInput: (value: string) => void;
  onSummarize: () => void;
  summary: () => string;
};

const SummarizePanel: Component<SummarizePanelProps> = (props) => {
  return (
    <>
      <TextField>
        <TextFieldLabel>Text to summarize</TextFieldLabel>
        <TextFieldTextArea
          data-testid="ai-summarize-input"
          rows={5}
          placeholder="Paste text to summarize"
          value={props.input()}
          onInput={(e) => props.setInput(e.currentTarget.value)}
          disabled={props.pending() || props.status().kind === "busy"}
        />
      </TextField>
      <Button
        class="w-full sm:w-auto"
        data-testid="ai-summarize"
        disabled={props.pending() || !props.input().trim() || props.status().kind === "busy"}
        onClick={() => props.onSummarize()}
      >
        Summarize
      </Button>
      <Show when={props.summary()}>
        <p
          class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
          data-testid="ai-summary-output"
        >
          {props.summary()}
        </p>
      </Show>
    </>
  );
};

export default SummarizePanel;
