import { createStore } from "zustand/vanilla";
import {
  clearThreadListError,
  createThreadListUiState,
  failThreadListRefresh,
  finishThreadListRefresh,
  setThreadListDrawerOpen,
  setThreadListSelectedCwd,
  startThreadListRefresh,
  toggleThreadListCollapsedGroup,
  toggleThreadListExpandedGroup,
} from "./thread-list-state.js";

export function createThreadListStore(initialThreadList = {}) {
  return createStore((set) => ({
    contextMenu: {
      clientX: 0,
      clientY: 0,
      threadId: null,
    },
    // Sidebar grouping mode: "sessions" (by cwd/folder, the default) or "projects".
    viewMode: initialThreadList.viewMode === "projects" ? "projects" : "sessions",
    setViewMode(mode) {
      set({ viewMode: mode === "projects" ? "projects" : "sessions" });
    },
    threadList: createThreadListUiState(initialThreadList),
    clearError() {
      set((state) => ({
        threadList: clearThreadListError(state.threadList),
      }));
    },
    failRefresh(message) {
      set((state) => ({
        threadList: failThreadListRefresh(state.threadList, message),
      }));
    },
    finishRefresh() {
      set((state) => ({
        threadList: finishThreadListRefresh(state.threadList),
      }));
    },
    setDrawerOpen(open) {
      set((state) => ({
        threadList: setThreadListDrawerOpen(state.threadList, open),
      }));
    },
    setSelectedCwd(cwd) {
      set((state) => ({
        threadList: setThreadListSelectedCwd(state.threadList, cwd),
      }));
    },
    startRefresh() {
      set((state) => ({
        threadList: startThreadListRefresh(state.threadList),
      }));
    },
    toggleCollapsedGroup(cwd) {
      set((state) => ({
        threadList: toggleThreadListCollapsedGroup(state.threadList, cwd),
      }));
    },
    toggleExpandedGroup(cwd) {
      set((state) => ({
        threadList: toggleThreadListExpandedGroup(state.threadList, cwd),
      }));
    },
    closeContextMenu() {
      set({
        contextMenu: {
          clientX: 0,
          clientY: 0,
          threadId: null,
        },
      });
    },
    openContextMenu(threadId, clientX = 0, clientY = 0) {
      set({
        contextMenu: {
          clientX,
          clientY,
          threadId: threadId || null,
        },
      });
    },
  }));
}

export function readThreadListUi(store) {
  return store?.getState?.().threadList || createThreadListUiState();
}

export function readThreadListContextMenu(store) {
  return store?.getState?.().contextMenu || {
    clientX: 0,
    clientY: 0,
    threadId: null,
  };
}

export function readThreadListViewMode(store) {
  return store?.getState?.().viewMode === "projects" ? "projects" : "sessions";
}
