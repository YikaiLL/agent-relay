/**
 * Build a per-thread "currently working" lookup from a session snapshot's
 * `thread_activity` array (see ThreadActivityView on the Rust side).
 *
 * The snapshot's top-level phase/tool fields describe only the active thread,
 * so they can't tell the sidebar which *other* threads are working. This map,
 * keyed by thread id, lets each thread row badge its own activity independently
 * of which thread the client is currently viewing.
 *
 * @param {{ thread_activity?: Array<{ thread_id?: string, phase?: string|null, tool?: string|null }> }} session
 * @returns {Map<string, { phase: string|null, tool: string|null }>}
 */
export function buildThreadActivityMap(session) {
  const map = new Map();
  const activity = session?.thread_activity;
  if (!Array.isArray(activity)) {
    return map;
  }

  for (const entry of activity) {
    if (!entry?.thread_id) {
      continue;
    }
    map.set(entry.thread_id, {
      phase: entry.phase ?? null,
      tool: entry.tool ?? null,
    });
  }

  return map;
}

/**
 * The phase/tool for ONE named thread, from whichever field actually holds it.
 *
 * The snapshot describes the active thread at the top level (`current_phase`,
 * `current_tool`) and every other thread in `thread_activity`. A caller that
 * picks the wrong one is wrong in a way that looks like working code: read the
 * map for the active thread and the pane never lights up; read the top level
 * for an inactive thread and it borrows whatever the active thread is doing.
 *
 * @param {object|null} session
 * @param {string|null} threadId
 * @returns {{ phase: string|null, tool: string|null }}
 */
export function threadActivityFor(session, threadId) {
  if (!session || !threadId) {
    return { phase: null, tool: null };
  }
  if (session.active_thread_id === threadId) {
    return { phase: session.current_phase ?? null, tool: session.current_tool ?? null };
  }
  const activity = buildThreadActivityMap(session).get(threadId);
  return { phase: activity?.phase ?? null, tool: activity?.tool ?? null };
}
