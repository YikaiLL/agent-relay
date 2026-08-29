// Public seam for the proprietary task-diff surface. The public stub exports a
// no-op implementation; `scripts/with-private.sh` swaps the real module into
// the same path before a private-enabled frontend build.
export {
  TaskDiffPane,
  taskDiffTotals,
} from "../../crates/sealwire-private/frontend/task-diff-react.js";
