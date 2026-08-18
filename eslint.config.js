import globals from "globals";

// Minimal lint pass focused on catching the class of bug that slips past
// `vite build`: free/undefined identifiers (e.g. a stray `session` reference
// that only throws `ReferenceError` at render time). esbuild happily emits
// undefined globals, so `no-undef` is the cheap static guard CI was missing.
//
// We deliberately keep the rule set tiny — this is a correctness tripwire, not
// a style gate. Add more rules only when there's appetite to clean the noise.
export default [
  {
    ignores: [
      "web/**",
      ".claude/**",
      "node_modules/**",
      "target/**",
      "src-tauri/target/**",
      // `dist*/**` only matches at the repo root; bundled output also shows up
      // nested (e.g. design/beautiful-ui/dist), and a minified React bundle
      // trips `no-undef` on things like __REACT_DEVTOOLS_GLOBAL_HOOK__.
      "dist*/**",
      "**/dist/**",
      // Gitignored maintainer scratch, like `markdown/`. CI checks out a tree
      // without it, so linting it locally only produces noise CI never sees —
      // and noise in a tripwire is how a real `no-undef` gets scrolled past.
      "design/**",
      "**/*.min.js",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
