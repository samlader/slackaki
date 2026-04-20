// Block Kit builders. Action IDs encode the permissionID so the button handler
// can route the response back to the right OpenCode session without state.

export const ACTION_PERMISSION_ACCEPT = "perm:accept";
export const ACTION_PERMISSION_ACCEPT_ALWAYS = "perm:accept-always";
export const ACTION_PERMISSION_DENY = "perm:deny";

export interface PermissionPromptInput {
  sessionId: string;
  permissionId: string;
  title: string;
  detail?: string;
}

export function permissionPromptBlocks(input: PermissionPromptInput) {
  const { sessionId, permissionId, title, detail } = input;
  const value = JSON.stringify({ sessionId, permissionId });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:lock: *${title}*${detail ? `\n\`\`\`${truncate(detail, 2500)}\`\`\`` : ""}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTION_PERMISSION_ACCEPT,
          text: { type: "plain_text", text: "Accept" },
          style: "primary",
          value,
        },
        {
          type: "button",
          action_id: ACTION_PERMISSION_ACCEPT_ALWAYS,
          text: { type: "plain_text", text: "Accept always" },
          value,
        },
        {
          type: "button",
          action_id: ACTION_PERMISSION_DENY,
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          value,
        },
      ],
    },
  ];
}

export function permissionResolvedText(decision: "accept" | "accept-always" | "deny", user: string): string {
  const label =
    decision === "accept"
      ? ":white_check_mark: Approved"
      : decision === "accept-always"
        ? ":white_check_mark: Approved (always)"
        : ":x: Denied";
  return `${label} by <@${user}>`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}
