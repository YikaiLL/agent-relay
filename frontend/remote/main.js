import * as dom from "./dom.js";
import { configureBrokerClient, connectBroker } from "./broker-client.js";
import {
  clearClaimLifecycle,
  configureRemoteActions,
  handleRemoteBrokerPayload,
  recoverRemoteSession,
  rejectPendingActions,
} from "./actions.js";
import {
  applyPairingQuery,
  beginPairing,
  forgetCurrentDevice,
  handleEncryptedPairingResult,
  sendPairingRequest,
} from "./pairing.js";
import { registerRemotePwa } from "./pwa.js";
import {
  configureRenderHandlers,
  renderDeviceMeta,
  renderEmptyState,
  renderLog,
  renderThreads,
  setRemoteSessionPanelOpen,
} from "./render.js";
import {
  applySessionSnapshot,
  refreshRemoteThreads,
  resumeRemoteSession,
  sendMessage,
  startRemoteSession,
  submitDecision,
  syncRemoteSnapshot,
  takeOverControl,
} from "./session-ops.js";
import { loadDeviceLabel, state } from "./state.js";

configureRenderHandlers({
  onResumeThread(threadId) {
    void resumeRemoteSession(threadId);
  },
});

configureBrokerClient({
  onBrokerReady(_frame, reason) {
    if (state.pairingTicket) {
      void sendPairingRequest();
      return;
    }

    if (state.remoteAuth) {
      void recoverRemoteSession(`broker ${reason}`);
    }
  },
  onBrokerPayload(payload) {
    return handleBrokerPayload(payload);
  },
  onBrokerDisconnect() {
    clearClaimLifecycle();
    rejectPendingActions("broker socket disconnected");
  },
  onRelayPresence(kind, peer) {
    if (kind === "joined" && peer?.role === "relay" && state.remoteAuth) {
      void recoverRemoteSession("relay joined");
    }
  },
});

configureRemoteActions({
  onApplySessionSnapshot: applySessionSnapshot,
  onSyncRemoteSnapshot: syncRemoteSnapshot,
});

dom.pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginPairing(dom.pairingInput.value);
});

dom.forgetDeviceButton.addEventListener("click", () => {
  forgetCurrentDevice();
});

dom.remoteSessionToggle.addEventListener("click", () => {
  setRemoteSessionPanelOpen(dom.remoteSessionPanel.hidden);
});

dom.remoteStartSessionButton.addEventListener("click", () => {
  void startRemoteSession();
});

dom.remoteThreadsRefreshButton.addEventListener("click", () => {
  void refreshRemoteThreads("manual refresh");
});

dom.remoteTakeOverButton.addEventListener("click", () => {
  void takeOverControl();
});

dom.remoteMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

dom.remoteTranscript.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (!approvalButton) {
    return;
  }

  void submitDecision(
    approvalButton.dataset.approvalDecision,
    approvalButton.dataset.approvalScope || "once"
  );
});

void boot();

async function boot() {
  if (!window.crypto?.getRandomValues) {
    renderLog("Secure random bytes are unavailable in this browser. Remote pairing cannot start here.");
  }
  void registerRemotePwa();

  dom.deviceLabelInput.value = loadDeviceLabel();
  setRemoteSessionPanelOpen(false);
  const pairingQuery = applyPairingQuery();
  renderDeviceMeta();
  renderEmptyState();
  renderThreads([]);

  if (pairingQuery) {
    await beginPairing(pairingQuery, { auto: true });
    return;
  }

  if (state.remoteAuth) {
    void connectBroker("initial boot");
  }
}

async function handleBrokerPayload(payload) {
  if (payload?.kind === "encrypted_pairing_result") {
    await handleEncryptedPairingResult(payload);
    return;
  }

  await handleRemoteBrokerPayload(payload);
}
