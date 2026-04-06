export function isExpiredPairingError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("pairing request is missing or expired")
    || normalized.includes("join_ticket has expired")
    || normalized.includes("pairing link has expired")
  );
}

export function expiredPairingMessage() {
  return "This QR code or pairing link has expired. Generate a new QR code from the local relay and scan it again.";
}

export function normalizePairingError(message) {
  if (isExpiredPairingError(message)) {
    return expiredPairingMessage();
  }
  return message || "unknown pairing error";
}
