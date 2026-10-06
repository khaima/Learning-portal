/* One rule that matters for plain ES modules with no type checker: every
   name must be defined (a typo or a half-finished refactor otherwise only
   shows up as a broken page). `npm run lint`; CI runs it too. */
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/", "supabase/", "scripts/", "vite.config.js", "eslint.config.js"] },
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, PasswordCredential: "readonly" },
    },
    rules: { "no-undef": "error" },
  },
  {
    // The service worker template; build-sw.mjs fills the two lists in.
    files: ["sw-template.js"],
    languageOptions: { globals: { ...globals.serviceworker, __CORE__: "readonly", __FILES__: "readonly" } },
  },
];
