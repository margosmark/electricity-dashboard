import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: "19.3.0" } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // A spread into a CALL passes the array's elements as the call's ARGUMENTS:
    // `f(...arr)` is `f(arr[0], arr[1], …)`. V8 refuses past the argument limit
    // with `RangeError: Maximum call stack size exceeded`, so an array whose
    // length comes from the uploaded file — readings, XML entries, bill blocks —
    // crashes the panel on a hostile or merely unusual export. Both known
    // instances were exactly that: `greenbutton/series.ts` (sibling <entry>
    // elements) and `shiftVerification.ts` (one calendar day's readings).
    //
    // Append or scan ONE element at a time instead. When the array provably
    // cannot grow (a fixed-length list), disable THIS line and state the bound.
    // Tests are out of scope: their arrays are fixture-sized.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression > SpreadElement[argument.type!='ArrayExpression']",
          message:
            "Never spread an array into a call: f(...arr) passes one ARGUMENT per element, and V8 throws RangeError: Maximum call stack size exceeded past ~125 000 elements. Loop it (for (const x of arr) out.push(x)), fold it (reduce), or chunk it. If the array provably cannot grow, // eslint-disable-next-line no-restricted-syntax -- <state the bound>.",
        },
      ],
    },
  },
]);

export default eslintConfig;
