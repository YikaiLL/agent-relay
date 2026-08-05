// The one definition of the default workspace's name.
//
// It was briefly two: `DEFAULT_WORKSPACE_LABEL` in header-labels.js and
// `ALL_SESSIONS_LABEL` in project-switcher.js, holding equal strings under a
// comment claiming they could not drift. They could — nothing compared them. The
// trigger's text and the option marked active in its own menu are the same claim
// rendered twice, so they have to come from the same place.
//
// Its own module because the two importers must not import each other:
// header-labels.js is a pure decision module used in plain unit tests, and
// project-switcher.js pulls in React.
//
// Naming note: this repo already uses "workspace" for a git working tree
// (workspace_diff, the Workspace panel) and for a tab set (tab-workspace-store).
// This is the tab-set sense — a project-less session opens into exactly that tab
// workspace. If the collision ever bites, this constant is the only place to change.
export const DEFAULT_WORKSPACE_LABEL = "Default Workspace";
