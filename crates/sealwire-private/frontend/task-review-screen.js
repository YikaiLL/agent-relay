import React from "react";

// Public-checkout placeholder. A public relay has no task-team driver, so the
// full-screen merge review is unreachable; keeping the export lets the frontend
// still build and keeps the proprietary module out of this tree.
export function TaskReviewScreen() {
  return React.createElement(React.Fragment);
}
