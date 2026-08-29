/**
 * Split an Orchestrator composer draft into a task proposal.
 *
 * First line = title; the rest = context. Used by "Propose as task" only — Send
 * is chat and stages nothing, so a draft becomes a proposal only when the user
 * asks for one.
 */
export function splitOrchestratorProposalDraft(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  const newline = trimmed.search(/\r?\n/);
  if (newline < 0) {
    return { title: trimmed, context: "" };
  }
  const title = trimmed.slice(0, newline).trim();
  if (!title) {
    return null;
  }
  return {
    title,
    context: trimmed.slice(newline).replace(/^\r?\n/, "").trim(),
  };
}
