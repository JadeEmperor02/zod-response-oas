# zod-response-oas

Express + Zod router that validates requests, and infers OpenAPI **response**
schemas directly from your `sendSuccess()` call sites — no separate response
schema to write or keep in sync.

## Where this fits

Libraries like `express-zod-oas`, `express-zod-openapi-autogen`, and
`@hono/zod-openapi` already solve request-side duplication well: one Zod
schema drives runtime validation, static types, and the OpenAPI request
docs. If that's all you need, those are mature, more widely used options.

Every one of them is still **config-first on responses** — you write
`responses: { 200: UserSchema }` on the route by hand. This library reads
the response schema from your `sendSuccess(res, { data })` call sites
directly, via static analysis (`ts-morph` — nothing is executed). If your
controllers already call a consistent response helper, you never write a
response schema at all.

## Install

```bash
npm install zod-response-oas
```

Peer dependencies: `express`, `zod` (v4+), `@asteasolutions/zod-to-openapi`.

## Quick start

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
  handler: getUserById,
});

export function getUserById(req, res) {
  const user = { id: req.params.id, name: "Jade" };
  return sendSuccess(res, { data: user });
}
```

`router.instance` is a normal Express `Router` — mount it at the **same**
`basePath` you configured, or routes 404 despite the OpenAPI doc looking
correct:

```typescript
app.use("/api/v1/users", router.instance);
```

`basePath` is used for the OpenAPI doc path key only; it does not
auto-mount anything.

## `sendSuccess` / `sendError`

Both take an options object, not positional arguments — this is
deliberate: with more than two params, positional arguments make it easy
to pass something in the wrong slot with no compiler warning (e.g. putting
`errors` where `others` belongs). An object with named, typed fields
catches that at the call site instead.

```typescript
sendSuccess(res, {
  data: user, // becomes the "data" field, and is what
  // gets inferred into your OpenAPI schema
  message: "User fetched", // optional — becomes "message" if present
  others: { requestId: "abc" }, // optional — spread onto the TOP LEVEL
  // of the response body, alongside data
  statusCode: 200, // optional, defaults to 200
});
```

produces:

```json
{
  "ok": true,
  "success": true,
  "message": "User fetched",
  "data": { "id": "1", "name": "Jade" },
  "requestId": "abc"
}
```

**`others` is for extra top-level fields that aren't part of the resource
itself** — pagination metadata, counts, request IDs, rate-limit info,
anything that sits alongside `data` rather than inside it:

```typescript
sendSuccess(res, {
  data: users,
  others: {
    pagination: { page: 1, totalPages: 5, totalCount: 97 },
  },
});
```

Only `data`'s shape is what gets extracted and turned into a Zod schema —
`message` and `others` are envelope, not payload, and aren't part of the
inferred response contract. If you need `others`' shape documented too,
pass an explicit `response:` schema that accounts for it.

`sendError` is simpler — `msg` is the one required argument, everything
else is optional:

```typescript
sendError(res, "User not found", {
  statusCode: 404,
  errors: { field: "id", reason: "no matching record" },
});
```

## Inferring responses automatically

Run the extraction + generation step against your controllers:

```bash
npx zod-response-oas generate --controllers "src/controllers/**/*.ts" --project-root .
```

This writes `response-schemas.generated.ts` — a real Zod schema per
handler, plus a `responseSchemas` lookup map keyed by handler name.
`--project-root` should point at the directory containing your own
`node_modules` (usually `.`) — the generator's embedded validation step
needs it to resolve your real `zod` install.

Wire the generated map in once at startup, and routes need no `response:`
line at all:

```typescript
import { useGeneratedResponseSchemas } from "zod-response-oas";
import { responseSchemas } from "./response-schemas.generated.js";

useGeneratedResponseSchemas(responseSchemas); // once, at startup
```

This relies on `handler` being a **named function reference**, not an
inline arrow written directly in the route config. Two things break it,
both surfaced with a console warning (or a thrown error in strict mode —
see below) rather than a silent fallback:

- **Inline arrows** — `handler: (req, res) => {...}` written directly in
  the config gets `.name === "handler"` (JS infers a function's name from
  the object property key it's assigned to), the same for every route
  written this way. It will never match a generated schema. Always pass a
  named function imported from your controller file.
- **HOC wrappers** — `handler: wrapAsync(getUserById)` where `wrapAsync`
  returns a new anonymous function loses the original name entirely.
  Either make the wrapper preserve `.name`
  (`Object.defineProperty(wrapped, "name", { value: fn.name })`) or pass
  `response:` explicitly for wrapped routes.

Pass `response:` explicitly on any route to override the generated
schema, or where the handler's name can't be relied on.

By default, a route that can't resolve a generated schema only warns and
falls back to a permissive schema — convenient in development, but it
means a stale generated file can silently ship an inaccurate OpenAPI
contract. Once `generate` is part of your build, turn on strict mode so
the same condition fails the build instead:

```typescript
const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  requireGeneratedResponses: true, // throws at startup instead of warning
});
```

A handler that calls `sendSuccess` more than once with different `data`
shapes gets a `z.union([...])` in the generated schema automatically —
rendered as an OpenAPI union (`oneOf`/`anyOf`, depending on how
`zod-to-openapi` maps it) rather than silently collapsed to whichever
shape ran first in testing.

Regenerate whenever a handler's response shape changes, ideally as a
`predeploy`/`prebuild` script so a stale generated file can't ship
silently.

### Mongoose documents

`data` is auto-unwrapped when it's a genuine `HydratedDocument<T>` (the
same interface `@types/mongoose` declares) — no `.toObject()`/`.toJSON()`
needed to avoid a warning:

```typescript
export function getUser(req, res) {
  const user = await User.findById(req.params.id); // HydratedDocument<IUser>
  return sendSuccess(res, { data: user }); // extracts IUser directly, no warning
}
```

**Real caveat, not a solved problem:** this assumes the document's
declared TypeScript type (`T` in `HydratedDocument<T>`) matches what
actually gets serialized. It won't if the schema has virtuals added via
`toJSON: { virtuals: true }`, if the document went through `.populate()`
(declared type may be `ObjectId`, runtime value is a full nested
document), or if a schema-level `transform` reshapes output at serialize
time. In any of those cases, the generated schema can silently diverge
from what `res.json()` actually sends. If your schema uses any of these
features, verify the generated schema against real output, or pass
`response:` explicitly.

Only a _nominal_ `interface HydratedDocument<T>` triggers the auto-unwrap
— a `type X = T & {...}` intersection alias with the same name does not
(TypeScript doesn't attach a resolvable symbol to intersection types the
same way), and correctly falls back to a warning instead of guessing.

### Known limitation: named type/interface responses

A `data` value typed against a named `interface` or `type` alias defined
elsewhere in your codebase — as opposed to an inline object literal —
**cannot currently be auto-generated**:

```typescript
interface UserResponse {
  id: string;
  name: string;
}

function getUser(): UserResponse {
  /* ... */
}

export function handler(req, res) {
  const user = getUser();
  return sendSuccess(res, { data: user }); // extracted as "UserResponse" —
  // generation throws, doesn't guess
}
```

The extractor correctly identifies the type as `UserResponse`, but the
isolated file generated for `ts-to-zod` doesn't include `UserResponse`'s
own declaration (it only exists in your original source), so `ts-to-zod`
can't resolve it. `zod-response-oas generate` fails loudly and specifically
for these — not silently, and not with a broken generated file — but it
does mean these routes need a hand-written `response:` schema for now.
This is a real architectural gap (pulling in referenced type declarations
transitively is real, unbuilt work), not a bug to work around by naming
things differently.

If your controllers commonly type responses against named
interfaces/DTOs, expect a real number of routes to need explicit
`response:` overrides on first adoption — run `generate` against your
actual codebase and read every failure before assuming zero-config
inference across the board.

## Automatic path parameter inference

Path params get a Zod schema inferred from their name, with no config
needed for the common case:

```typescript
router.get("/:id", { handler: getUserById });
// :id → z.string().regex(/^[0-9a-fA-F]{24}$/) — Mongo ObjectId format, by default
```

Any `*id`-suffixed param (`:id`, `:userId`, `:parentId`, ...) defaults to
Mongo ObjectId validation, since this library originated in a
Mongoose-heavy codebase and that remains the most common case for its
audience. Non-id params default to a plain string:

```typescript
router.get("/by-slug/:slug", { handler: getBySlug });
// :slug → z.string(), no format constraint
```

### Overriding the default globally

If your IDs aren't Mongo ObjectIds — UUIDs, ULIDs, whatever — override the
default for every `*id`-suffixed param across a whole router:

```typescript
const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  autoParamSchemas: { id: "uuid" }, // now :id, :orderId, :parentId, etc. all expect UUIDs
});
```

Built-in strategies: `"mongo"`, `"uuid"`, `"ulid"`, `"cuid"`, `"cuid2"`,
`"nanoid"`, `"snowflake"`, `"slug"`, `"number"`, `"string"`, or pass any
Zod schema directly for full control:

```typescript
autoParamSchemas: {
  id: "uuid",
  code: z.string().length(6).toUpperCase(),
  "*": "slug", // fallback for any param not otherwise matched
}
```

Per-route overrides merge on top of router-level ones:

```typescript
router.get("/:id/legacy/:legacyId", {
  autoParamSchemas: { legacyId: "number" }, // only for this route
  handler: getLegacyThing,
});
```

An explicit `params:` schema always wins outright and disables
auto-inference entirely for that route — auto-inference only ever fills a
gap you haven't explicitly filled yourself.

## Security schemes

```typescript
registerSecurityScheme({
  name: "jwt",
  scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
});

const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  secureWith: ["jwt"], // which registered schemes secure:true routes require
});

router.get("/:id", { secure: true, handler: getUserById });
```

**`secure: true` is a documentation-only flag.** It adds the `security`
block to the generated OpenAPI doc; it does **not** itself add any
request-blocking behavior. Real enforcement comes from `middleware:`:

```typescript
router.get("/:id", {
  secure: true,
  middleware: [requireAuth], // THIS is what actually blocks unauthenticated requests
  handler: getUserById,
});
```

A route with `secure: true` and no `middleware:` will document itself as
requiring auth while actually accepting every request. This is standard
Express behavior (the router has no way to know what "auth" means for
your app), but it's an easy assumption to make incorrectly, so it's called
out here explicitly.

Every route also automatically gets `400`/`401`/`500` response classes
registered in the OpenAPI doc, regardless of `secure`.

## CLI reference

```bash
npx zod-response-oas generate \
  --tsconfig tsconfig.json \
  --controllers "src/controllers/**/*.ts" \
  --output response-shapes.json \
  --schema-output response-schemas.generated.ts \
  --success-helper sendSuccess \
  --project-root . \
  --skip-validation   # optional — skips ts-to-zod's embedded type-check
```

## Status

Extensively corpus-tested — 70+ unit/integration tests plus a 28-case
controller corpus exercising nested objects, arrays, `.map()` projections,
unions (inline and named), ternaries, branching `sendSuccess` calls,
optional/nullable fields, `Record`/index signatures, tuples,
intersections, Mongoose documents (both raw and normalized), primitives,
and async/`Promise`-returning handlers — verified via real `.safeParse`
checks against valid and invalid data, not just "didn't throw."

Known limitations, stated plainly rather than glossed over:

- Named interface/type-alias responses aren't auto-generatable (see
  above) — needs a hand-written `response:` override.
- `ts-to-zod` itself has real limits (generics, mapped types); the CLI
  surfaces exactly which handler failed rather than silently emitting
  `any`.
- A literal `data: null` currently fails generation due to a `ts-to-zod`
  internal quirk with the `null` type specifically — other primitives
  (`number`, `string`, `boolean`) are unaffected.
- Multi-file re-runs regenerate the whole output file rather than
  diffing — fine for CI, noisy for local watch-mode workflows.
- The extractor's notion of "a function that calls sendSuccess" isn't the
  same as "a function actually registered as an Express route handler" —
  an unused helper that happens to call `sendSuccess` gets a schema
  generated for it too. Harmless, but worth knowing.
