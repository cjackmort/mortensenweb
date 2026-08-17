import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * ESLint flat config.
 *
 * ESLint 9 dropped `.eslintrc` in favour of this file, and the project had
 * neither — so `npm run lint` had been failing outright rather than passing
 * over unlinted code. A lint script that errors is worse than one that is
 * absent: it looks like tooling noise, so people stop reading its output, and
 * then a real finding arrives and nobody notices.
 *
 * The two imports compose without overlapping:
 *   `core-web-vitals` = the base Next config (React, hooks, import, jsx-a11y)
 *                        plus the Core Web Vitals rules
 *   `typescript`      = typescript-eslint's recommended set, plus the ignores
 *                        for `.next/`, `out/`, `build/`, and `next-env.d.ts`
 *
 * Neither pulls in type-aware linting, which needs a `project` reference and a
 * full type build on every run. `tsc --noEmit` already runs in CI and catches
 * that class of problem faster, so paying for it twice buys nothing.
 */

const config = [
  /**
   * ESLint's own baseline, which neither Next config turns on.
   *
   * Without it the correctness rules everyone assumes are running are not:
   * `no-control-regex`, `no-misleading-character-class`, `no-fallthrough`,
   * `no-sparse-arrays`. The tell was a `// eslint-disable-next-line
   * no-control-regex` in `lib/storage` that ESLint reported as *unused* — the
   * author had written a suppression for a rule that was never enabled, and
   * believed a check was in place that was not.
   */
  js.configs.recommended,

  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    // Everything the Next configs do not already exclude. `.pglite` is the
    // local embedded database, `.attachments` is uploaded client images, and
    // `.netlify` is deploy scratch — none of it is source, and all of it is
    // large enough to make a lint run feel broken.
    ignores: [
      ".pglite/**",
      ".attachments/**",
      ".netlify/**",
      ".open-next/**",
      "drizzle/**",
    ],
  },

  {
    rules: {
      /**
       * Unused values are an error, with one carve-out: a leading underscore.
       *
       * Server actions in this codebase take `(_previous, formData)` because
       * React's `useActionState` passes the previous state whether or not the
       * action wants it. That parameter cannot be removed — the signature is
       * fixed by React — so flagging it would train everyone to ignore the
       * rule rather than to fix it.
       */
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

  {
    /**
     * Test files reach into the database directly to set up state, which means
     * non-null assertions on rows that were just inserted. Requiring a guard
     * there would add noise to every fixture without making any test safer —
     * a fixture that failed to insert fails the test on the next line anyway.
     */
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];

export default config;
