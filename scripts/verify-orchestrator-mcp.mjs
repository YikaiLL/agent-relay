// Drive the Orchestrator's MCP toolset against a REAL relay.
//
// The unit suites test each side in isolation, which is exactly how the
// `device_id` bug survived them: the bridge forwarded an id the relay was never
// told to send. So this runs the real bridge process, driven by a real MCP
// client, against a real relay, and asserts the card actually lands in state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = path.dirname(fileURLToPath(new URL("..", import.meta.url)));
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

let relay;
let transport;
const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

try {
  const port = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-mcp-"));
  relay = startLocalRelay({
    relayPort: port,
    relayStatePath: path.join(stateDir, "session.json"),
    // Beta needs BOTH the flag and a build that can run the feature
    // (`SEALWIRE_BETA && cfg!(feature = "private")`), so this script requires a
    // binary built under scripts/with-private.sh. A stub build refuses
    // everything, which is correct and makes for a useless verification.
    extraEnv: { AGENT_PROVIDERS: "fake", SEALWIRE_BETA: "1" },
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/api/health`);

  const api = async (p, init = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const snap0 = await api("/api/session");
  const beta = snap0.body?.data?.beta_features_enabled;
  check(
    "the relay is up with beta ON (needs a --features private build)",
    beta === true,
    beta === true ? "" : "rebuild: scripts/with-private.sh cargo build -p relay-server --features private"
  );
  // No pairing flow here: a local controller identifies itself by whatever id it
  // sends, and the relay scopes an unknown device to the roots it already allows.
  const deviceId = "verify-device";

  // 1. The Orchestrator exists, and picked a provider deliberately.
  const ensured = await api("/api/orchestrator/ensure", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  });
  let orchId = ensured.body?.data?.thread_id;
  check("ensure_orchestrator returns a thread", Boolean(orchId), orchId ?? JSON.stringify(ensured.body));

  const snap1 = await api("/api/session");
  // NOT via `threads`: the Orchestrator is a BACKGROUND thread (registered with
  // register_background_thread so opening Tasks does not steal the active
  // conversation), and background rows are filtered out of the navigation list.
  // The pin is where it is advertised.
  check(
    "the snapshot pins the Orchestrator",
    snap1.body?.data?.orchestrator_thread_id === orchId,
    `pin=${snap1.body?.data?.orchestrator_thread_id}`
  );
  const again = await api("/api/orchestrator/ensure", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  });
  check(
    "ensure is idempotent — a second call reuses the pin",
    again.body?.data?.thread_id === orchId,
    `${again.body?.data?.thread_id} vs ${orchId}`
  );

  // 1b. Reset is the opposite of ensure and has to be: a pin can point at a
  // thread the relay still resolves while its provider session is gone, and then
  // `ensure` hands the same dead id back forever. This is the button's route.
  const reset = await api("/api/orchestrator/reset", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  });
  const resetId = reset.body?.data?.thread_id;
  check(
    "reset retires the pinned Orchestrator and opens another",
    Boolean(resetId) && resetId !== orchId,
    `${resetId} vs ${orchId}`
  );
  const afterReset = await api("/api/session");
  check(
    "the pin moves with it, so the next ensure does not return the old one",
    afterReset.body?.data?.orchestrator_thread_id === resetId,
    `${afterReset.body?.data?.orchestrator_thread_id} vs ${resetId}`
  );

  orchId = resetId ?? orchId;

  // 2. The tools route answers, and filters by live state.
  const tools0 = await api("/api/orchestrator/tools");
  const names0 = (tools0.body?.data?.tools ?? []).map((t) => t.name);
  check(
    "an empty workspace is offered propose_task and nothing that would fail",
    names0.includes("propose_task") && !names0.includes("control_run") && !names0.includes("revise_proposal"),
    names0.join(", ")
  );
  const proposeSpec = (tools0.body?.data?.tools ?? []).find((t) => t.name === "propose_task");
  check(
    "the schema is well-formed and closed",
    proposeSpec?.input_schema?.type === "object" &&
      proposeSpec.input_schema.additionalProperties === false &&
      proposeSpec.input_schema.required.includes("title"),
    JSON.stringify(proposeSpec?.input_schema?.required)
  );

  // 3. The REAL bridge process, driven by a REAL MCP client, against this relay.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, "claude-worker", "orchestrator-mcp.mjs")],
    env: { ...process.env, SEALWIRE_RELAY_URL: base, SEALWIRE_DEVICE_ID: deviceId },
  });
  const client = new Client({ name: "verify", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  check("the MCP bridge completes a handshake against the live relay", true);

  const listed = await client.listTools();
  check(
    "tools/list over MCP matches what the relay offers",
    listed.tools.map((t) => t.name).sort().join(",") === names0.slice().sort().join(","),
    listed.tools.map((t) => t.name).join(", ")
  );
  check(
    "inputSchema survives the snake_case -> camelCase hop",
    listed.tools.every((t) => t.inputSchema?.type === "object"),
    ""
  );

  // 4. A real tool call must stage a card — and start nothing.
  const called = await client.callTool({
    name: "propose_task",
    arguments: { title: "Add a parser", context: "Touch the CLI." },
  });
  check(
    "propose_task over MCP is accepted (this is where the device_id bug bit)",
    called.isError === false,
    called.content?.[0]?.text ?? ""
  );
  check(
    "the tool tells the model it did NOT start work",
    /NOT started/.test(called.content?.[0]?.text ?? ""),
    called.content?.[0]?.text ?? ""
  );

  const snap2 = await api("/api/session");
  const cards = snap2.body?.data?.orchestrator_proposals ?? [];
  check(
    "the card is really in relay state, with the title the model sent",
    cards.length === 1 && cards[0].title === "Add a parser",
    JSON.stringify(cards.map((c) => c.title))
  );
  check(
    "nothing was started — no team run exists",
    (snap2.body?.data?.team_runs ?? []).length === 0,
    `runs=${(snap2.body?.data?.team_runs ?? []).length}`
  );

  // 5. The tool list is a function of live state, re-read per call.
  const listed2 = await client.listTools();
  check(
    "with a card staged, revise_proposal becomes available",
    listed2.tools.some((t) => t.name === "revise_proposal"),
    listed2.tools.map((t) => t.name).join(", ")
  );

  // 6. A refusal reaches the model as a readable result, not a fault.
  const refused = await client.callTool({ name: "propose_task", arguments: { title: "  " } });
  check(
    "a blank title is refused as a readable tool result",
    refused.isError === true && /title/.test(refused.content?.[0]?.text ?? ""),
    refused.content?.[0]?.text ?? ""
  );
  const invented = await client.callTool({
    name: "propose_task",
    arguments: { title: "x", branch: "main" },
  });
  check(
    "an invented argument is refused rather than silently dropped",
    invented.isError === true && /branch/.test(invented.content?.[0]?.text ?? ""),
    invented.content?.[0]?.text ?? ""
  );

  // 7. Revise must not blank what it was not given.
  const revised = await client.callTool({
    name: "revise_proposal",
    arguments: { proposal_id: cards[0].id, why: "They own the CLI." },
  });
  const snap3 = await api("/api/session");
  const card = (snap3.body?.data?.orchestrator_proposals ?? [])[0];
  check(
    "revising one field leaves the rest of the card intact",
    revised.isError === false && card?.title === "Add a parser" && card?.context === "Touch the CLI.",
    `title=${card?.title} context=${card?.context} why=${card?.why}`
  );
} catch (error) {
  check("harness ran to completion", false, error?.stack || String(error));
} finally {
  if (transport) await transport.close().catch(() => {});
  if (relay) await stopManagedProcess(relay).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
