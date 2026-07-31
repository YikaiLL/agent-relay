// The agent's mark — one renderer for every surface that shows "which agent is this".
//
// Consolidated from two byte-identical copies (thread-list-react.js, session-tab-strip.js)
// that differed only in the class they set; a third copy was about to be added for the
// remote Providers panel.
//
// A provider we ship no icon for returns null rather than borrowing another vendor's
// logo, which would mislabel the session. `provider-icons.js` covers exactly claude_code
// and codex, so every caller MUST handle null — either leaving the slot empty (a fixed
// slot keeps alignment) or falling back to the provider's name in text.

import React from "react";
import { providerIconSvg } from "./provider-icons.js";

const h = React.createElement;

/**
 * @param {string} provider  provider id (e.g. "codex", "claude_code")
 * @param {string} className the surface's own class for the mark slot
 * @returns {object|null} a React element, or null when no icon ships for this provider
 */
export function providerMark(provider, className = "provider-mark") {
  const icon = providerIconSvg(provider);
  if (!icon) return null;
  return h("span", {
    className,
    "data-provider": provider,
    dangerouslySetInnerHTML: { __html: icon },
  });
}
