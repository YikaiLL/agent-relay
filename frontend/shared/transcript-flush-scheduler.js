// One pending-render slot per surface, shared by every event source that
// touches the transcript (streaming deltas, snapshots, approvals, …). See
// .sealwire/PLAN.md, "The scheduler contract".

export const TRANSCRIPT_FLUSH_MIN_WINDOW_MS = 100;
export const TRANSCRIPT_FLUSH_MAX_WINDOW_MS = 300;
export const TRANSCRIPT_FLUSH_CHAR_THRESHOLD = 1024;

function defaultNow() {
  return Date.now();
}

// Prefers `window.setTimeout`/`clearTimeout` over the bare global the same
// way the coalescer this replaces did: a test that stubs `window` (rather
// than the process-global timers) must still be able to drive this
// deterministically instead of a real native timer firing during the run.
function defaultSetTimer(callback, delayMs) {
  const scheduleTimeout = globalThis.window?.setTimeout?.bind(globalThis.window) || setTimeout;
  return scheduleTimeout(callback, delayMs);
}

function defaultClearTimer(handle) {
  const cancelTimeout = globalThis.window?.clearTimeout?.bind(globalThis.window) || clearTimeout;
  cancelTimeout(handle);
}

function defaultIsHidden() {
  return typeof document !== "undefined" && document.hidden === true;
}

export function createTranscriptFlushScheduler({
  render,
  now = defaultNow,
  setTimer = defaultSetTimer,
  clearTimer = defaultClearTimer,
  isHidden = defaultIsHidden,
} = {}) {
  let windowMs = TRANSCRIPT_FLUSH_MIN_WINDOW_MS;
  let timerHandle = null;
  // Belt-and-suspenders alongside `timerHandle`: a re-queue after cancel must
  // not let a stale timer the host failed to clear resurrect as a render.
  let generation = 0;
  let pendingChars = 0;
  let renderCount = 0;
  let lastRenderDurationMs = 0;
  let lastFlushReason = null;
  // Sticky until a render actually proves itself fast enough to decay.
  // Compared against the FIXED TRANSCRIPT_FLUSH_MIN_WINDOW_MS in runFlush(),
  // never against `windowMs` itself (live OR a value captured earlier in the
  // same flush) — `windowMs` is ITSELF derived from this flag one line later
  // (computeWindowMs()), so comparing against it measures each render
  // against a target that flip-flops with the flag it is trying to set: a
  // steady render duration would alternate stretch/decay forever instead of
  // settling. Only the fixed floor gives a stable answer to "did this render
  // genuinely get fast enough."
  let renderOutlastedWindow = false;

  function isPending() {
    return timerHandle != null;
  }

  function clampWindow(ms) {
    return Math.min(TRANSCRIPT_FLUSH_MAX_WINDOW_MS, Math.max(TRANSCRIPT_FLUSH_MIN_WINDOW_MS, ms));
  }

  // Two step conditions, not a ramp: there is no meaningful "half stretched"
  // window, so this jumps between the two ends of the clamped range.
  function computeWindowMs() {
    const stretch = renderOutlastedWindow || Boolean(isHidden());
    return clampWindow(stretch ? TRANSCRIPT_FLUSH_MAX_WINDOW_MS : TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  }

  function clearPendingTimer() {
    if (timerHandle != null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  }

  function runFlush(reason) {
    clearPendingTimer();
    generation += 1;
    pendingChars = 0;
    lastFlushReason = reason || lastFlushReason;
    const startedAt = now();
    render();
    lastRenderDurationMs = Math.max(0, now() - startedAt);
    // Against the fixed floor, not `windowMs` — see renderOutlastedWindow's
    // own doc above for why.
    renderOutlastedWindow = lastRenderDurationMs > TRANSCRIPT_FLUSH_MIN_WINDOW_MS;
    renderCount += 1;
    windowMs = computeWindowMs();
  }

  function schedule(reason) {
    lastFlushReason = reason || lastFlushReason;
    if (isPending()) {
      // Single slot: an already-scheduled flush absorbs this call instead of
      // resetting its window, which is what turns N deltas into one render.
      return;
    }
    windowMs = computeWindowMs();
    const scheduledGeneration = generation;
    timerHandle = setTimer(() => {
      if (timerHandle == null || scheduledGeneration !== generation) {
        return;
      }
      runFlush(lastFlushReason);
    }, windowMs);
  }

  return {
    queue(reason) {
      schedule(reason);
    },
    note(chars) {
      if (!Number.isFinite(chars) || chars <= 0) {
        return;
      }
      pendingChars += chars;
      // Only brings forward a render that is already coming — note() must
      // never become a scheduler in its own right (see PLAN.md's char-
      // threshold trap: a fast provider should never actually hit this).
      if (isPending() && pendingChars >= TRANSCRIPT_FLUSH_CHAR_THRESHOLD) {
        runFlush(lastFlushReason || "char-threshold");
      }
    },
    flushNow(reason) {
      // Renders unconditionally — an immediate-class caller has just
      // committed state synchronously and needs it on screen now, whether or
      // not anything happened to be queued. Absorbs (invalidates) any
      // pending window flush rather than doubling up.
      runFlush(reason || lastFlushReason);
    },
    cancel() {
      if (!isPending()) {
        return;
      }
      clearPendingTimer();
      generation += 1;
      pendingChars = 0;
    },
    stats() {
      return {
        renderCount,
        windowMs,
        pending: isPending(),
        pendingChars,
        lastRenderDurationMs,
        lastFlushReason,
      };
    },
  };
}
