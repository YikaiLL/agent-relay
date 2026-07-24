// Live click test for the reviewer card's session-id "i" toggle. The sibling
// reviewer-panel.test.mjs uses renderToStaticMarkup (initial markup only), so it can
// prove the id is collapsed by default and the toggle is wired — but NOT that clicking
// actually inserts/removes `.reviewer-job-thread`. That last invariant needs a real DOM
// + React state, so this file mounts the panel under jsdom and clicks for real.
//
// jsdom is a devDependency: it is not in the package `files` allowlist and npm never
// installs devDependencies for consumers, so this adds nothing to the published package.
//
// Kept in its own file so the DOM globals below don't leak into the static-render suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A DOM must exist before react-dom/client is imported, so set the globals first and
// pull React/ReactDOM in dynamically afterwards.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
// Note: `navigator` is a read-only global in modern Node, so we don't reassign it;
// React reads `window.navigator`, which is jsdom's.
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
// Tell React we're inside an act()-managed test environment (silences the act warning).
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ReviewerPanel } = await import("../shared/reviewer-panel.js");

const h = React.createElement;

function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("clicking the info toggle reveals, then hides, the reviewer session id line", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        reviewJobs: [
          {
            id: "r1",
            reviewer_provider: "codex",
            status: "waiting_for_reviewer",
            reviewer_thread_id: "rev-thread-7",
          },
        ],
        canRequest: false,
        // No fetchReviewerTranscript on purpose: the card's polling effect early-returns
        // without it, so nothing async runs during this synchronous toggle test.
      })
    );
  });

  const toggle = container.querySelector(".reviewer-job-info");
  assert.ok(toggle, "the info toggle should render when there is a reviewer session");

  // Collapsed by default: no id line, toggle reports not-expanded.
  assert.equal(container.querySelector(".reviewer-job-thread"), null, "id line hidden by default");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  // Click → the id line appears with the full id, toggle flips to expanded.
  await act(async () => click(toggle));
  const line = container.querySelector(".reviewer-job-thread");
  assert.ok(line, "clicking the toggle reveals the id line");
  assert.equal(line.textContent, "rev-thread-7", "revealed line shows the full session id");
  assert.equal(
    container.querySelector(".reviewer-job-info").getAttribute("aria-expanded"),
    "true"
  );

  // Click again → the id line is removed again (true toggle, not one-way reveal).
  await act(async () => click(container.querySelector(".reviewer-job-info")));
  assert.equal(
    container.querySelector(".reviewer-job-thread"),
    null,
    "clicking again hides the id line"
  );
  assert.equal(
    container.querySelector(".reviewer-job-info").getAttribute("aria-expanded"),
    "false"
  );

  await act(async () => root.unmount());
  container.remove();
});
