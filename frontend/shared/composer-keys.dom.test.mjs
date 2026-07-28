// Live keyboard test for the composer, mounted under jsdom. The sibling
// composer-keys.test.mjs proves the pure logic and the handler wiring against
// fake DOM objects; this file proves the *real* React path end-to-end: a genuine
// KeyboardEvent dispatched at the textarea flows through React's synthetic event
// system, reaches our onKeyDown, and drives form submission / caret movement.
//
// It specifically nails the IME guard through the real event shape — React does
// not surface `isComposing` on its synthetic event, so the handler reads
// `nativeEvent.isComposing` (and the keyCode-229 fallback); only a real event
// exercises that path.
//
// jsdom is a devDependency (already used by other tests, e.g.
// local/reviewer-panel.interaction.test.mjs). jsdom does no layout, so this
// covers logical-line Home/End, not visual soft-wrap navigation.
//
// Kept in its own file so the DOM globals below don't leak into the
// static-render suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A DOM must exist before react-dom/client is imported, so set the globals first
// and pull React/ReactDOM in dynamically afterwards.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConversationComposer } = await import("./composer.js");

const h = React.createElement;

// Dispatch a real keydown at the textarea. jsdom's KeyboardEvent ignores
// `isComposing`/`keyCode` in its init dict, so we force them on afterwards —
// exactly the shape the browser hands React as `nativeEvent`.
function fireKey(textarea, opts) {
  const evt = new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: opts.key,
    shiftKey: opts.shiftKey || false,
    metaKey: opts.metaKey || false,
    ctrlKey: opts.ctrlKey || false,
    altKey: opts.altKey || false,
  });
  if (opts.isComposing) Object.defineProperty(evt, "isComposing", { value: true });
  if (opts.keyCode) Object.defineProperty(evt, "keyCode", { value: opts.keyCode });
  textarea.dispatchEvent(evt);
  return evt.defaultPrevented;
}

test("real React path: Enter submit, Shift+Enter, IME guard, disabled Send, Home/End", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const counters = { submits: 0 };

  function Harness() {
    const [draft, setDraft] = React.useState("hello world");
    return h(
      "form",
      {
        onSubmit: (event) => {
          event.preventDefault();
          counters.submits += 1;
        },
      },
      h(ConversationComposer, {
        currentDraft: draft,
        onDraftChange: setDraft,
        // Force the policy so the test doesn't depend on jsdom's matchMedia/UA.
        enterSubmits: true,
        remapHomeEnd: true,
        messageId: "message-input",
        sendButtonId: "send-button",
        models: [{ display_name: "gpt", model: "gpt" }],
        onModelChange() {},
      })
    );
  }

  await act(async () => {
    root.render(h(Harness));
  });

  const textarea = container.querySelector("#message-input");
  const sendBtn = container.querySelector("#send-button");
  assert.ok(textarea, "composer textarea mounted");
  assert.ok(sendBtn, "send button mounted");

  // --- plain Enter → exactly one submit, newline suppressed ---
  counters.submits = 0;
  let prevented;
  await act(async () => {
    prevented = fireKey(textarea, { key: "Enter" });
  });
  assert.equal(counters.submits, 1, "plain Enter submits once");
  assert.equal(prevented, true, "plain Enter suppresses the newline");

  // --- Shift+Enter → no submit, no preventDefault (textarea inserts newline) ---
  counters.submits = 0;
  await act(async () => {
    prevented = fireKey(textarea, { key: "Enter", shiftKey: true });
  });
  assert.equal(counters.submits, 0, "Shift+Enter does not submit");
  assert.equal(prevented, false, "Shift+Enter is left to the textarea");

  // --- IME composition via the real nativeEvent shape → no submit ---
  counters.submits = 0;
  await act(async () => {
    prevented = fireKey(textarea, { key: "Enter", isComposing: true });
  });
  assert.equal(counters.submits, 0, "Enter mid-IME (nativeEvent.isComposing) does not submit");
  assert.equal(prevented, false);
  await act(async () => {
    fireKey(textarea, { key: "Enter", keyCode: 229 });
  });
  assert.equal(counters.submits, 0, "Enter with keyCode 229 does not submit");

  // --- disabled Send button → Enter does not submit ---
  counters.submits = 0;
  sendBtn.disabled = true;
  await act(async () => {
    fireKey(textarea, { key: "Enter" });
  });
  assert.equal(counters.submits, 0, "Enter with a disabled Send button does not submit");
  sendBtn.disabled = false;

  // --- Home / End / Shift+Home move the caret in a real textarea ---
  textarea.value = "abc\ndefghi";
  textarea.setSelectionRange(7, 7);
  await act(async () => {
    prevented = fireKey(textarea, { key: "Home" });
  });
  assert.equal(prevented, true, "Home is handled");
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [4, 4], "Home → line start");

  textarea.setSelectionRange(5, 5);
  await act(async () => {
    fireKey(textarea, { key: "End" });
  });
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [10, 10], "End → line end");

  textarea.setSelectionRange(7, 7);
  await act(async () => {
    fireKey(textarea, { key: "Home", shiftKey: true });
  });
  assert.deepEqual(
    [textarea.selectionStart, textarea.selectionEnd],
    [4, 7],
    "Shift+Home extends selection to line start"
  );

  // --- Cmd+Home is left to the browser (document navigation) ---
  textarea.setSelectionRange(7, 7);
  await act(async () => {
    prevented = fireKey(textarea, { key: "Home", metaKey: true });
  });
  assert.equal(prevented, false, "Cmd+Home is not intercepted");

  await act(async () => {
    root.unmount();
  });
});
