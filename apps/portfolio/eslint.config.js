import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Mirrors `apps/platform/eslint.config.js` — same three layers, same reasoning.
 * Kept as its own file rather than shared because the two apps have different
 * ignore sets and there is no `packages/eslint-config` to hold a shared one
 * yet. If a third app appears, extract it then.
 */
const config = [
  js.configs.recommended,
  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    ignores: ["out/**", ".netlify/**"],
  },

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
];

export default config;
