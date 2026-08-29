import React from "react";

// Public-checkout placeholder. A public relay has no task-team driver, so the
// corresponding screen is unreachable; keeping the same exports lets the whole
// frontend still build and keeps the proprietary module out of this tree.
export function taskDiffTotals() {
  return { files: 0, added: 0, removed: 0 };
}

export function TaskDiffPane() {
  return React.createElement(React.Fragment);
}
