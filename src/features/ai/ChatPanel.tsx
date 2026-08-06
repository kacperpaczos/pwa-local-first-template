import { For, type Component } from "solid-js";
import type { AiStatus } from "@/ai";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";

export type ChatTurn = { role: "user" | "assistant"; text: string };

type ChatPanelProps = {
  turns: () => ChatTurn[];
  pending: () => boolean;
  status: () => AiStatus;
  input: () => string;
  setInput: (value: string) => void;
  onSend: () => void;
};

const ChatPanel: Component<ChatPanelProps> = (props) => {
  return (
    <>
      <div
        class="max-h-72 space-y-3 overflow-auto rounded-md border bg-muted/20 p-3"
        data-testid="ai-chat-log"
      >
        <For each={props.turns()} fallback={<p class="text-sm text-muted-foreground">No messages yet.</p>}>
          {(turn) => (
            <div class="space-y-1">
              <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {turn.role === "user" ? "You" : "AI"}
              </p>
              <p class="whitespace-pre-wrap text-sm">{turn.text || (props.pending() ? "…" : "")}</p>
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
          value={props.input()}
          onInput={(e) => props.setInput(e.currentTarget.value)}
          disabled={props.pending() || props.status().kind === "busy"}
        />
      </TextField>
      <Button
        class="w-full sm:w-auto"
        data-testid="ai-chat-send"
        disabled={props.pending() || !props.input().trim() || props.status().kind === "busy"}
        onClick={() => props.onSend()}
      >
        Send
      </Button>
    </>
  );
};

export default ChatPanel;
