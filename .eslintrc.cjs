module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "script",
  },
  rules: {
    // `while (true)` stream-pump/retry loops are idiomatic here.
    "no-constant-condition": ["error", { checkLoops: false }],
    // `_`-prefix marks intentionally-unused params/vars (kept for signature
    // position or documentation).
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
};
