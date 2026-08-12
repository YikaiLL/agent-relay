import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = React.createElement;

function installBrowserStubs() {
  const storage = new Map();
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const {
  MissingCredentialsState,
  RelayHomeState,
  SessionPanel,
  WorkspaceHeading,
} = await import("../react-renderer.js");
const { ProjectSwitcher } = await import("../../shared/project-switcher.js");

test("RelayHomeState renders the paired relay chooser", () => {
  const markup = renderToStaticMarkup(
    h(RelayHomeState, {
      clientAuth: { clientId: "client-1" },
      onSelectRelay() {},
      relayDirectory: [
        {
          relayId: "relay-1",
          relayLabel: "Work Mac",
          deviceLabel: "Primary Phone",
          hasLocalProfile: true,
          grantedAt: null,
        },
      ],
    })
  );

  assert.match(markup, /Choose a relay/);
  assert.match(markup, /Work Mac/);
  assert.match(markup, /Open relay/);
});

test("RelayHomeState renders first-pair copy when no relays exist", () => {
  const markup = renderToStaticMarkup(
    h(RelayHomeState, {
      clientAuth: null,
      onSelectRelay() {},
      relayDirectory: [],
    })
  );

  assert.match(markup, /Pair your first relay/);
  assert.match(markup, /Open a pairing QR code/);
});

test("MissingCredentialsState renders re-pair guidance", () => {
  const markup = renderToStaticMarkup(
    h(MissingCredentialsState, {
      remoteAuth: {
        relayLabel: "Work Mac",
      },
    })
  );

  assert.match(markup, /Local credentials missing/);
  assert.match(markup, /Pair this relay again on this device/);
  assert.match(markup, /Work Mac/);
});

test("WorkspaceHeading renders the shared project switcher without session badges", () => {
  const markup = renderToStaticMarkup(
    h(WorkspaceHeading, {
      header: {
        modelLabel: "Claude · default",
        subtitle: "",
        subtitleHidden: true,
        title: "agent-relay",
      },
      statusBadge: { label: "working", tone: "ready", headerVisible: false },
      titleNode: h(ProjectSwitcher, {
        activeProjectId: "project-1",
        projects: [{ id: "project-1", name: "UI Redesign" }],
        titleId: "remote-workspace-title",
      }),
    })
  );

  assert.match(markup, /UI Redesign/);
  assert.match(markup, /project-switcher-caret/);
  assert.doesNotMatch(markup, /Claude · default/);
  assert.doesNotMatch(markup, /working/i);
  assert.doesNotMatch(markup, /remote-status-badge/);
  assert.doesNotMatch(markup, /remote-model-badge/);
});

test("WorkspaceHeading keeps alert status visible", () => {
  const markup = renderToStaticMarkup(
    h(WorkspaceHeading, {
      header: {
        subtitle: "",
        subtitleHidden: true,
        title: "agent-relay",
      },
      statusBadge: { label: "Re-pair required", tone: "alert", headerVisible: true },
    })
  );

  assert.match(markup, /id="remote-status-badge"/);
  assert.match(markup, /Re-pair/);
});

test("WorkspaceHeading keeps offline status visible", () => {
  const markup = renderToStaticMarkup(
    h(WorkspaceHeading, {
      header: {
        subtitle: "",
        subtitleHidden: true,
        title: "agent-relay",
      },
      statusBadge: { label: "Offline", tone: "offline", headerVisible: true },
    })
  );

  assert.match(markup, /id="remote-status-badge"/);
  assert.match(markup, /status-badge-offline/);
  assert.match(markup, /Offline/);
});

test("WorkspaceHeading can show a ready-toned important status", () => {
  const markup = renderToStaticMarkup(
    h(WorkspaceHeading, {
      header: {
        subtitle: "",
        subtitleHidden: true,
        title: "Pair this browser",
      },
      statusBadge: { label: "Approval pending", tone: "ready", headerVisible: true },
    })
  );

  assert.match(markup, /id="remote-status-badge"/);
  assert.match(markup, /Approval/);
});

test("SessionPanel renders provider and model selects with correct field bindings", () => {
  const fieldsCalled = [];
  const onFieldChange = (field, value) => {
    fieldsCalled.push({ field, value });
  };

  const markup = renderToStaticMarkup(
    h(SessionPanel, {
      model: {
        effortOptions: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
        ],
        fields: {
          approvalPolicy: "untrusted",
          cwd: "/tmp/project",
          effort: "medium",
          initialPrompt: "",
          model: "gpt-5.5",
          provider: "codex",
          sandbox: "workspace-write",
        },
        hasRemoteAuth: true,
        hasUsableRelay: true,
        providerOptions: [
          { label: "Codex", value: "codex" },
          { label: "Claude Code", value: "claude_code" },
        ],
        startPending: false,
        models: [
          { model: "gpt-5.5", display_name: "GPT-5.5", provider: "" },
          { model: "claude-sonnet-4-6", display_name: "Sonnet", provider: "anthropic" },
        ],
        workspaceSuggestions: [],
      },
      onFieldChange,
    })
  );

  // Renders both provider and model selects
  assert.match(markup, /id="remote-launch-provider-input"/);
  assert.match(markup, /id="remote-launch-model-input"/);

  // Provider select shows both options with correct values
  assert.match(markup, /<option[^>]*value="codex"[^>]*>Codex<\/option>/);
  assert.match(markup, /<option[^>]*value="claude_code"[^>]*>Claude Code<\/option>/);

  // Provider select has correct current value
  assert.match(markup, /<select[^>]*id="remote-launch-provider-input"[^>]*>/);
  assert.match(markup, /value="codex"/);

  // Model select shows all models from the model list
  assert.match(markup, /GPT-5\.5/);
  assert.match(markup, /Sonnet/);
});
