# zod-response-oas

Express + Zod router with request validation and OpenAPI generation, plus one
thing the other Express/Zod/OpenAPI libraries don't do: **it infers your
success-response schema from the code that sends the response, instead of
asking you to declare it a second time.**

## Where this fits

Libraries like `express-zod-oas`, `express-zod-openapi-autogen`, and
`@hono/zod-openapi` already solve request-side duplication well: one Zod
schema drives runtime validation, static types, and the OpenAPI request
body/params/query docs. If that's all you need, those are mature, more
widely used options — use them.

Every one of them is still **config-first on responses**: you write
`responses: { 200: UserSchema }` on the route. That's one canonical place
instead of three, which is real progress, but it's still something a human
has to write and keep matched to what the handler actually sends.

This library reads the response schema from your `sendSuccess(res, { data
})` call sites directly, via static analysis (`ts-morph` — nothing is
executed). If your controllers already call a consistent response helper,
you never write a response schema at all.

## Requirements for the inference to work

- Your success responses go through one helper function (default name:
  `sendSuccess`), called as `sendSuccess(res, { data: ..., message?, ... })`.
- If a handler branches into multiple distinct success shapes, this is
  detected and surfaced as `oneOf` in the generated schema — not silently
  collapsed to whichever branch runs first.
- Raw ORM documents (Mongoose `HydratedDocument`, etc.) passed straight into
  `data` are flagged as warnings, not silently converted — normalize with
  `.toObject()`/`.toJSON()` first so generated schemas don't leak internal
  fields.
- Anything the static analysis can't confidently resolve (spread properties,
  computed keys, non-object-literal call arguments) is reported, not
  guessed.

## Quick start

```bash
npm install zod-response-oas
```

```typescript
import {
  createSmartRouter,
  sendSuccess,
  registerSecurityScheme,
} from "zod-response-oas";
import z from "zod";

registerSecurityScheme({
  name: "jwt",
  scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
});

const router = createSmartRouter({ basePath: "/api/v1/users", tag: "Users" });

router.get("/:id", {
  summary: "Get a user by ID",
  secure: true,
  handler: (req, res) => {
    const user = { id: req.params.id, name: "Jade" };
    return sendSuccess(res, { data: user });
  },
});
```

Wire the generated schemas in once at startup, then routes need no
`response:` line at all — it's resolved automatically from the handler's
own name. First, run the extraction + generation step against your
controllers:

```bash
npx zod-response-oas generate --controllers "src/controllers/**/*.ts" --project-root .
```

This writes `response-schemas.generated.ts` — a real Zod schema per
handler, plus a `responseSchemas` lookup map keyed by handler name.
`--project-root` should point at the directory containing your own
`node_modules` (usually `.`) — the generator's embedded validation step
needs it to resolve your real `zod` install.

Then wire it in:

```typescript
import {
  createSmartRouter,
  sendSuccess,
  useGeneratedResponseSchemas,
} from "zod-response-oas";
import { responseSchemas } from "./response-schemas.generated.js";

useGeneratedResponseSchemas(responseSchemas); // once, at startup

const router = createSmartRouter({ basePath: "/api/v1/users", tag: "Users" });

router.get("/:id", {
  summary: "Get a user by ID",
  secure: true,
  handler: getUserById, // <- imported, named function reference. No response: needed.
});
```

```typescript
// controllers/user.controller.ts
export function getUserById(req, res) {
  const user = { id: req.params.id, name: "Jade" };
  return sendSuccess(res, { data: user });
}
```

This relies on `handler` being a **named function reference**, not an
inline arrow written directly in the route config. Two things break it,
both surfaced with a console warning rather than a silent fallback:

- **Inline arrows** — `handler: (req, res) => {...}` written directly in
  the config object gets `.name === "handler"` (JS infers a function's name
  from the object property key it's assigned to), the same for every route
  written this way. It will never match a generated schema. Always pass a
  named function imported from your controller file.
- **HOC wrappers** — `handler: wrapAsync(getUserById)` where `wrapAsync`
  returns a new anonymous function loses the original name entirely. Either
  make the wrapper preserve `.name`
  (`Object.defineProperty(wrapped, "name", { value: fn.name })`) or pass
  `response:` explicitly for wrapped routes.

Pass `response:` explicitly on any route where you want to override the
generated schema, or where the handler's name can't be relied on.

A handler that calls `sendSuccess` more than once with different `data`
shapes gets a `z.union([...])` automatically — the doc reflects the real
branching behavior instead of whichever shape ran first in testing.

Regenerate whenever a handler's response shape changes, ideally as a
`predeploy`/`prebuild` script so a stale generated file can't ship silently.

## Status

The full loop works end to end: extract shapes from `sendSuccess` call
sites → convert to Zod via `ts-to-zod` → wire into `RouteConfig.response`.
Known rough edges, tracked as issues once this is public:

- Anything `ts-to-zod` itself can't represent (generics, mapped types) —
  the CLI surfaces which handler failed rather than silently emitting `any`.
- Multi-file re-runs currently regenerate the whole output file rather than
  diffing — fine for CI, noisy for local watch-mode workflows.
- Windows path handling in the temp-file step is untested.

## What this is not

- Not a request-validation innovation — that part is deliberately similar
  to prior art, because prior art already solved it well.
- Not framework-agnostic (yet) — Express-specific for now.
- Not a replacement for reading your own OpenAPI output before shipping it.
