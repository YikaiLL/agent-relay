// Public seam for the proprietary full-screen merge review (15a). The public
// stub exports a placeholder; `scripts/with-private.sh` swaps the real module
// into the same path before a private-enabled frontend build.
//
// Separate from `task-diff-react.js` so a public checkout can stub the screen
// without stubbing the summary panel — two surfaces, two lifetimes.
export { TaskReviewScreen } from "../../crates/sealwire-private/frontend/task-review-screen.js";
