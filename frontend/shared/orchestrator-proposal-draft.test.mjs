import test from "node:test";
import assert from "node:assert/strict";

import { splitOrchestratorProposalDraft } from "./orchestrator-proposal-draft.js";

test("a one-line draft is the whole title", () => {
  assert.deepEqual(splitOrchestratorProposalDraft("  Add a parser  "), {
    title: "Add a parser",
    context: "",
  });
});

test("the first line is the title and the rest is context", () => {
  assert.deepEqual(
    splitOrchestratorProposalDraft("Add a parser\n\nTouch the CLI.\nKeep tests green."),
    {
      title: "Add a parser",
      context: "Touch the CLI.\nKeep tests green.",
    }
  );
});

test("blank drafts are refused", () => {
  assert.equal(splitOrchestratorProposalDraft(""), null);
  assert.equal(splitOrchestratorProposalDraft("   "), null);
  assert.equal(splitOrchestratorProposalDraft("\n\n"), null);
});
