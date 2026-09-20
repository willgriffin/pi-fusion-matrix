import js from "@eslint/js";
import globals from "globals";

/**
 * Linting for this repository, and the two of its hard constraints that are mechanical.
 *
 * The rules are `@eslint/js` plus what this codebase actually needs; there is no plugin, because both repo
 * guards are expressible in core rules and a plugin nobody can read is a plugin nobody maintains.
 *
 * A credential-shaped env var is banned *by name* (`process.env.SOMETHING_KEY`), not computed access:
 * `process.env[backend.apiKeyEnv]` in the decision backend is the one place a key is named, read through the
 * backend's own config, and it is the seam the credential constraint exists to keep narrow. `process.env.HOME`
 * and `process.env.PI_CODING_AGENT_DIR` are not credentials and stay legal.
 */
const CREDENTIAL_SHAPED = "/KEY|TOKEN|SECRET|PASSWORD/i";

export default [
  { ignores: ["node_modules/**", "docs/**", "tools/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "error",
      // `== null` is the deliberate null-or-undefined check; every other loose comparison is a bug.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      "no-implicit-coercion": ["error", { boolean: false }],
    },
  },
  {
    // The extension is a library inside someone else's process: a status line belongs in the stream it returns,
    // not on a stderr nobody reads, and a credential belongs in the harness's store, not in this code.
    files: ["extensions/**/*.js"],
    rules: {
      "no-console": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.name=${CREDENTIAL_SHAPED}]`,
          message:
            "a credential-shaped env var read by name: a key belongs to the harness's store, and the decision backend's `apiKeyEnv` is the one place one is named — through the backend's config, not a literal here",
        },
        {
          selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.value=${CREDENTIAL_SHAPED}]`,
          message:
            "a credential-shaped env var read by name: a key belongs to the harness's store, and the decision backend's `apiKeyEnv` is the one place one is named — through the backend's config, not a literal here",
        },
      ],
    },
  },
  {
    // Operator tools and tests print on purpose: the report is a terminal artifact, a probe reports a backend,
    // and a check names what failed.
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    rules: { "no-console": "off" },
  },
];
