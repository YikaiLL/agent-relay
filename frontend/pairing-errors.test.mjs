import test from "node:test";
import assert from "node:assert/strict";

import {
  PAIRING_TICKET_SUPERSEDED_CODE,
  classifyBrokerPairingError,
  expiredPairingMessage,
  isExpiredPairingError,
  normalizePairingError,
} from "./remote/pairing-errors.js";

test("isExpiredPairingError recognizes the expiry wordings the relay and broker emit", () => {
  assert.ok(isExpiredPairingError("pairing request is missing or expired"));
  assert.ok(isExpiredPairingError("join_ticket has expired"));
  assert.ok(isExpiredPairingError("Pairing link has expired"));
  assert.ok(!isExpiredPairingError("something else went wrong"));
});

test("normalizePairingError rewrites expiry into an actionable message", () => {
  assert.equal(normalizePairingError("join_ticket has expired"), expiredPairingMessage());
  assert.equal(normalizePairingError("boom"), "boom");
  assert.equal(normalizePairingError(""), "unknown pairing error");
});

// SECURITY / correctness: the broker seats at most one peer per pairing ticket, so
// a later join supersedes an earlier holder. The loser MUST stop using that ticket.
// The remote client reconnects automatically on close, so if this error is merely
// logged, two clients holding the same QR ping-pong — each reconnect evicting the
// other — until the ticket expires, and neither ever pairs.
test("classifyBrokerPairingError makes a superseded ticket terminal, not retryable", () => {
  const decision = classifyBrokerPairingError(
    { code: PAIRING_TICKET_SUPERSEDED_CODE, message: "another client joined with this pairing ticket" },
    { hasPairingTicket: true }
  );

  assert.equal(decision.terminal, true, "must not be retried");
  assert.match(decision.message, /another (device|client)|scan/i);
});

test("classifyBrokerPairingError treats an expired ticket as terminal too", () => {
  const decision = classifyBrokerPairingError(
    { code: "join_rejected", message: "join_ticket has expired" },
    { hasPairingTicket: true }
  );

  assert.equal(decision.terminal, true);
  assert.equal(decision.message, expiredPairingMessage());
});

test("classifyBrokerPairingError leaves unrelated broker errors retryable", () => {
  const decision = classifyBrokerPairingError(
    { code: "rate_limited", message: "slow down" },
    { hasPairingTicket: true }
  );

  assert.equal(decision.terminal, false, "transient broker errors must keep retrying");
  assert.equal(decision.message, null);
});

test("classifyBrokerPairingError ignores pairing wording when no pairing is in flight", () => {
  const decision = classifyBrokerPairingError(
    { code: "join_rejected", message: "join_ticket has expired" },
    { hasPairingTicket: false }
  );

  assert.equal(decision.terminal, false, "a paired device's own reconnect must not be killed");
});
