/** Subset of the Claude Code PreToolUse hook input that pdd cares about. */
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  cwd?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
  };
}

export type HookDecision = { allow: true } | { allow: false; reason: string };

/** Claude Code: exit code 2 blocks the tool call and shows stderr to the model. */
export const HOOK_DENY_EXIT = 2;
