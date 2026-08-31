# Extractor corpus for `zod-response-oas`

Intentional stress set for the static-analysis pipeline:

```
controller source
  → ts-morph (CallExpression + getType().getText())
  → type text strings
  → synthetic `export type X = ...`
  → ts-to-zod CLI
  → Zod schema source + responseSchemas map
```

Philosophy (from product design):

- **Do not generate a confidently wrong OpenAPI document.**
- If the analyzer cannot confidently determine the shape, **fail loudly / report** — do not invent `z.any()` or guess keys.
- Multiple distinct `sendSuccess` shapes in one handler → **retain all** → `z.union` / OpenAPI `oneOf`.
- Spreads, non-object-literal second args, computed-only shapes → **warnings**, not silent success.

## Layout

```
controllers/
  01-simple.ts              … object literal
  02-nested.ts              … nested object
  03-list-array.ts          … array of objects
  04-mapped.ts              … .map() projection
  05-typed-interface.ts     … explicit interface
  06-optional-properties.ts … optional props
  07-unions.ts              … union type
  08-ternary.ts             … ternary → union of arms
  09-multiple-calls.ts      … branching sendSuccess → oneOf
  10-no-data.ts             … no data field → undefined → {}
  11-fail-computed-variable.ts  … opaque variable (expect fail/warn)
  12-fail-spread.ts         … spread in options (expect warn)
  13-fail-build-response.ts … second arg is call, not literal (expect warn)
  14-fail-generic.ts        … genericResult<T>() (expect ts-to-zod fail)
  15-const-arrow.ts         … export const arrow (name from VariableDeclaration)
  16-message-and-others.ts  … envelope fields ignored; only data extracted
  17-null-and-primitives.ts … number | string | boolean | null
  18-as-const-literal.ts    … literal types
  19-array-of-unions.ts     … Item[]
  20-record-index-signature.ts … Record<string, number>
  21-readonly-tuple.ts      … readonly [string, number]
  22-intersection.ts        … A & B
  23-nested-optional-nullable.ts
  24-fail-computed-key.ts   … [dynamicKey]: value
  25-mongoose-raw-doc-warning.ts … HydratedDocument warning + normalized path
  26-deeply-nested.ts
  27-empty-object.ts
  28-promise-unwrapped.ts   … await then pass
```

Files prefixed `fail-*` are **expected to produce warnings or conversion failures**. That is correct behavior.

## Automated tests (Vitest)

`extractor-corpus.test.ts` is a drop-in suite for the package (~540 lines, two describes).

1. Copy this folder into the repo (e.g. `tests/fixtures/extractor-corpus/`) **or** keep it beside the test and fix relative paths.
2. Point the imports at `extractResponseShapes` and `generateZodSchemas`.
3. Ensure `express` types and the corpus `tsconfig.json` are visible to ts-morph.

```bash
npx vitest run path/to/extractor-corpus.test.ts
```

**Suite 1 — extract only**

- Discovers `FunctionDeclaration` + `const` arrow handlers
- Asserts confident shapes (simple → deeplyNested, primitives, unions, …)
- Asserts `multipleCalls` has **two** `typeTexts`
- Asserts spread / non-literal second arg → **warnings + empty typeTexts**
- Asserts raw `HydratedDocument` warns; `.toObject()` does not

**Suite 2 — extract → generateZodSchemas**

- Happy-path subset converts and lands in `responseSchemas`
- `multipleCalls` → `z.union` + single map entry
- `noData` (`undefined`) → empty-object schema, no crash
- Warn-only handlers omitted from the map (not `handler: undefined`)
- `failGeneric` → ts-to-zod **throws** (no silent `z.any()`)

## Manual extract (no Vitest)

From a checkout that includes `extractResponseShapes`:

```ts
import { extractResponseShapes } from "zod-response-oas";

const results = extractResponseShapes({
  tsconfigPath: "./tsconfig.json",
  controllerGlobs: "path/to/extractor-corpus/controllers/**/*.ts",
  outputPath: "./extractor-corpus-results.json",
  successHelperName: "sendSuccess",
});

console.log(JSON.stringify(results, null, 2));
```

Then feed `results` into `generateZodSchemas` and inspect:

1. Which handlers produced `typeTexts` vs only `warnings`.
2. Whether multi-call handlers got multiple `typeTexts` (union path).
3. Whether `ts-to-zod` threw on generics / unsupported constructs and named the handler.
4. Whether `constArrow` was discovered (VariableDeclaration path).

## Expected high-level outcomes

| Case | Confident shape? | Notes |
|------|------------------|--------|
| 01–03, 05–10, 15–19, 22–23, 26–27 | Yes | Core happy path |
| 04 mapped | Likely yes | Depends on callback return type inference |
| 08 ternary | Yes | Type of ternary is union of arms |
| 09 multiple calls | Yes (2 shapes) | Must not collapse |
| 11 computed variable | No / any | Report uncertainty |
| 12 spread | Warning | Explicit path in extractor |
| 13 buildResponse() | Warning | Non-object-literal second arg |
| 14 generic | Conversion fail | Surface handler name |
| 20 Record | Maybe | ts-to-zod index signature support |
| 21 readonly tuple | Maybe | readonly/tuple edge |
| 24 computed key | Partial / warn | Prefer incomplete over wrong keys |
| 25 raw HydratedDocument | Warning + type text | Normalized sibling should be clean |
| 28 await | Likely yes | Resolved type after await |

## Adding cases

1. New file under `controllers/` with a short header comment: `CORPUS: …`, `EXPECT: …`, `SHOULD: succeed | fail loudly`.
2. Use a **named** `export function` or `export const name = (...) =>` so the extractor can key by `handler`.
3. Always call `sendSuccess(res, { data: ... })` (or spread / non-literal) — that is the only surface the analyzer looks at.
4. Prefer types that TypeScript can resolve without running code; the pipeline is pure static analysis.

## Anti-goals for the corpus

- Do not add cases whose only purpose is “make it pass with `z.any()`”.
- Do not require runtime execution of controllers.
- Do not hide uncertainty: if a case is ambiguous, the fixture comment should say so.
