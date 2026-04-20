// Convert CommonMark-ish markdown (what OpenCode emits) to Slack mrkdwn.
// Code fences and inline code are preserved verbatim.

export function mdToMrkdwn(input: string): string {
  if (!input) return input;

  // 1. Extract code spans so we don't mangle them.
  const placeholders: string[] = [];
  const stash = (chunk: string) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(chunk);
    return token;
  };

  let text = input
    // Fenced code blocks: ```lang\n...```
    .replace(/```[\s\S]*?```/g, (m) => stash(m))
    // Inline code: `...`
    .replace(/`[^`\n]+`/g, (m) => stash(m));

  // 2. Bold: **x** or __x__ → *x*. Use a sentinel so the italic pass below
  //    doesn't re-interpret the asterisks. Headings route through the same
  //    sentinel so "# Heading" renders as bold, not italic.
  const boldSentinels: string[] = [];
  const stashBold = (inner: string) => {
    const token = `\u0001${boldSentinels.length}\u0001`;
    boldSentinels.push(inner);
    return token;
  };
  text = text
    .replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, inner) => stashBold(inner))
    .replace(/\*\*([^\n*]+?)\*\*/g, (_, inner) => stashBold(inner))
    .replace(/__([^\n_]+?)__/g, (_, inner) => stashBold(inner));

  // 4. Italic: *x* or _x_ → _x_. Require non-space boundaries so we don't
  //    eat list bullets or stray asterisks.
  text = text
    .replace(/(^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?=[^\w*]|$)/g, "$1_$2_")
    .replace(/(^|[^\w_])_([^\s_][^_\n]*?[^\s_]|[^\s_])_(?=[^\w_]|$)/g, "$1_$2_");

  // 5. Strikethrough: ~~x~~ → ~x~
  text = text.replace(/~~([^~\n]+?)~~/g, "~$1~");

  // 6. Links: [label](url) → <url|label>. Bare <http…> stays as-is.
  text = text.replace(/\[([^\]]+?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "<$2|$1>");

  // 7. Unordered list bullets beginning with "* " → "• " (so the asterisk
  //    isn't read as bold).
  text = text.replace(/^(\s*)\*\s+/gm, "$1• ");

  // 8. Restore bold sentinels as Slack bold.
  text = text.replace(/\u0001(\d+)\u0001/g, (_, i) => `*${boldSentinels[Number(i)]}*`);

  // 9. Restore code spans.
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);

  return text;
}
