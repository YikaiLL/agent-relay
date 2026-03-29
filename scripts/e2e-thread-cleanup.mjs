import { setTimeout as delay } from "node:timers/promises";

function authHeaders(bearerToken) {
  return bearerToken
    ? {
        Authorization: `Bearer ${bearerToken}`,
      }
    : {};
}

function extractErrorMessage(payload, fallback) {
  return (
    payload?.error?.message ||
    payload?.message ||
    (typeof payload?.error === "string" ? payload.error : null) ||
    fallback
  );
}

export async function fetchSession(relayPort, { bearerToken } = {}) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session`, {
    headers: authHeaders(bearerToken),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || payload?.error || "failed to fetch relay session");
  }
  return payload.data;
}

export async function deleteThreadAndWait(
  relayPort,
  threadId,
  { bearerToken, cwd, timeoutMs = 15000 } = {}
) {
  if (!threadId) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort, { bearerToken });
    if (session.active_thread_id !== threadId || !session.active_turn_id) {
      break;
    }
    await delay(250);
  }

  let deleted = false;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadId)}/delete`,
      {
        method: "POST",
        headers: authHeaders(bearerToken),
      }
    );
    const payload = await response.json();
    if (response.ok && payload?.ok) {
      deleted = true;
      break;
    }
    const errorMessage = extractErrorMessage(
      payload,
      `failed to delete local thread ${threadId}`
    );
    if (errorMessage.includes("Codex is still running")) {
      await delay(250);
      continue;
    }
    throw new Error(errorMessage);
  }

  if (!deleted) {
    throw new Error(`timed out waiting for local thread ${threadId} to become deletable`);
  }

  while (Date.now() < deadline) {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const threadsResponse = await fetch(`http://127.0.0.1:${relayPort}/api/threads${query}`, {
      headers: authHeaders(bearerToken),
    });
    const threadsPayload = await threadsResponse.json();
    if (!threadsResponse.ok || !threadsPayload?.ok) {
      throw new Error(extractErrorMessage(
        threadsPayload,
        `failed to list threads while waiting for ${threadId} to disappear`
      ));
    }
    const threads = threadsPayload.data?.threads || [];
    if (!threads.some((thread) => thread.id === threadId)) {
      return;
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for deleted thread ${threadId} to disappear from relay list`);
}
