export function base64UrlToBytes(value) {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + padding;
  return base64ToBytes(normalized);
}

function base64ToBytes(value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
