import { createStore } from "zustand/vanilla";
import { defaultModelForProvider } from "../shared/provider-settings.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
} from "../shared/last-used-settings.js";
import { loadDeviceLabel } from "./state.js";
import { THREAD_STATES } from "../shared/thread-dot.js";
import { notificationPermission } from "../shared/thread-notify.js";
import { pushSupported } from "./push-subscribe.js";

export function createDefaultSessionDraft(provider = "codex") {
  return {
    approvalPolicy: loadLastApprovalPolicy(provider) || "untrusted",
    cwd: "",
    effort: loadLastEffort(provider) || "medium",
    initialPrompt: "",
    provider,
    model: defaultModelForProvider(provider),
    sandbox: "workspace-write",
  };
}

export function createRemoteUiStore(initialState = {}) {
  return createStore((set) => ({
    composerDraft: "",
    // Empty = "this surface hasn't overridden the session's effort". Readers
    // fall back to session.reasoning_effort, so opening a session on a new
    // device shows/sends its real effort instead of a hardcoded medium.
    composerEffort: "",
    composerModel: "",
    deviceLabelDraft: loadDeviceLabel(),
    pairingInputValue: "",
    pairingModalOpen: false,
    forkDialog: {
      open: false,
      pending: false,
      sourceThread: null,
      fields: null,
      error: "",
    },
    remoteInfoModalOpen: false,
    providerModels: {},
    // Per-provider catalog fetch status: "loading" | "ready" | "error".
    // Lets the new-session dialog show a truthful state instead of silently
    // presenting a single fallback model when a fetch is pending or failed.
    providerModelsStatus: {},
    providers: [],
    // Web Push / PWA notification state. Initialized from feature detection and
    // the current Notification permission (both guarded so a Node/SSR import is
    // safe).
    pushSupported: pushSupported(),
    pushPermission: notificationPermission(),
    pushSubscribed: false,
    sendPending: false,
    // The bell. Same shape and rules as local's `state.threadFilter` — see
    // shared/thread-filter.js — but held here because remote has no imperative `state`
    // object. `retained` is a Map on purpose: thread ids are arbitrary strings.
    threadFilter: { on: false, states: [...THREAD_STATES], retained: new Map() },
    sessionDraft: createDefaultSessionDraft(),
    sessionPanelOpen: false,
    sessionStartPending: false,
    ...initialState,
    // Turning the bell on, or changing which states it covers, RESETS retention:
    // carrying it across a deliberate change of selection would show rows the user just
    // excluded.
    setThreadFilter(next) {
      set((state) => ({
        threadFilter: { ...state.threadFilter, ...next, retained: new Map() },
      }));
    },
    // The retention map is a monotonic accumulator recomputed each render, not a user
    // action — kept off `setThreadFilter` so it cannot reset what it is accumulating.
    setThreadFilterRetained(retained) {
      set((state) => ({ threadFilter: { ...state.threadFilter, retained } }));
    },
    clearComposerDraft() {
      set({
        composerDraft: "",
      });
    },
    resetPairingInput() {
      set({
        pairingInputValue: "",
      });
    },
    setComposerDraft(value) {
      set({
        composerDraft: value || "",
      });
    },
    setComposerEffort(value) {
      set({
        composerEffort: value || "",
      });
    },
    setComposerModel(value) {
      set({
        composerModel: value || "",
      });
    },
    setDeviceLabelDraft(value) {
      set({
        deviceLabelDraft: value || "",
      });
    },
    setPairingInputValue(value) {
      set({
        pairingInputValue: value || "",
      });
    },
    setPairingModalOpen(open) {
      set({
        pairingModalOpen: Boolean(open),
      });
    },
    setForkDialog(next) {
      set((state) => ({
        forkDialog: {
          ...state.forkDialog,
          ...(next || {}),
        },
      }));
    },
    closeForkDialog() {
      set({
        forkDialog: {
          open: false,
          pending: false,
          sourceThread: null,
          fields: null,
          error: "",
        },
      });
    },
    setRemoteInfoModalOpen(open) {
      set({
        remoteInfoModalOpen: Boolean(open),
      });
    },
    setProviderModels(provider, models) {
      set((state) => ({
        providerModels: {
          ...state.providerModels,
          [provider]: models || [],
        },
      }));
    },
    setProviderModelsStatus(provider, status) {
      set((state) => ({
        providerModelsStatus: {
          ...state.providerModelsStatus,
          [provider]: status,
        },
      }));
    },
    setProviders(providers) {
      set({
        providers: providers || [],
      });
    },
    setPushSupported(value) {
      set({
        pushSupported: Boolean(value),
      });
    },
    setPushPermission(value) {
      set({
        pushPermission: value || "default",
      });
    },
    setPushSubscribed(value) {
      set({
        pushSubscribed: Boolean(value),
      });
    },
    setSendPending(value) {
      set({
        sendPending: Boolean(value),
      });
    },
    setSessionDraftField(field, value) {
      set((state) => ({
        sessionDraft: {
          ...state.sessionDraft,
          [field]: value,
        },
      }));
    },
    setSessionPanelOpen(open) {
      set({
        sessionPanelOpen: Boolean(open),
      });
    },
    setSessionStartPending(value) {
      set({
        sessionStartPending: Boolean(value),
      });
    },
  }));
}
