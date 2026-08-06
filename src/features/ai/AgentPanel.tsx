import { For, Show, type Component } from "solid-js";
import type { AiStatus, PendingWrite, Skill } from "@/ai";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";

type AgentPanelProps = {
  pending: () => boolean;
  status: () => AiStatus;
  input: () => string;
  setInput: (value: string) => void;
  skills: Skill[];
  skillId: () => string;
  setSkillId: (id: string) => void;
  selectedSkill: () => Skill | undefined;
  onRun: () => void;
  agentAnswer: () => string;
  pendingWrite: () => PendingWrite | null;
  onConfirmWrite: () => void;
  onCancelWrite: () => void;
};

const AgentPanel: Component<AgentPanelProps> = (props) => {
  return (
    <>
      <p class="text-sm text-muted-foreground">
        Local tool loop over your notes. Writes need confirmation.
      </p>
      <label class="block space-y-1 text-sm">
        <span class="font-medium">Skill</span>
        <select
          class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          data-testid="ai-agent-skill"
          value={props.skillId()}
          onChange={(e) => props.setSkillId(e.currentTarget.value)}
          disabled={props.pending() || props.status().kind === "busy"}
        >
          <For each={props.skills}>{(skill) => <option value={skill.id}>{skill.name}</option>}</For>
        </select>
      </label>
      <Show when={props.selectedSkill()}>
        {(skill) => <p class="text-xs text-muted-foreground">{skill().description}</p>}
      </Show>
      <TextField>
        <TextFieldLabel>Task</TextFieldLabel>
        <TextFieldTextArea
          data-testid="ai-agent-input"
          rows={3}
          placeholder="e.g. Find notes about pasta and propose a summary note"
          value={props.input()}
          onInput={(e) => props.setInput(e.currentTarget.value)}
          disabled={props.pending() || props.status().kind === "busy"}
        />
      </TextField>
      <Button
        class="w-full sm:w-auto"
        data-testid="ai-agent-run"
        disabled={props.pending() || !props.input().trim() || props.status().kind === "busy"}
        onClick={() => props.onRun()}
      >
        Run agent
      </Button>
      <Show when={props.agentAnswer()}>
        <p
          class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm"
          data-testid="ai-agent-output"
        >
          {props.agentAnswer()}
        </p>
      </Show>
      <Show when={props.pendingWrite()}>
        {(pw) => (
          <Alert data-testid="ai-agent-confirm">
            <AlertTitle>Confirm write</AlertTitle>
            <AlertDescription class="space-y-3">
              <p>{pw().summary}</p>
              <div class="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="ai-agent-confirm-yes"
                  disabled={props.pending()}
                  onClick={() => props.onConfirmWrite()}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="ai-agent-confirm-no"
                  disabled={props.pending()}
                  onClick={props.onCancelWrite}
                >
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </Show>
    </>
  );
};

export default AgentPanel;
