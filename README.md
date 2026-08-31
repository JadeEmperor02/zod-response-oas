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
the response shape from your `sendSuccess(res, { data / message / others })`
call sites via static analysis (`ts-morph` — nothing is executed). If your
controllers already call a consistent response helper, you often never write
a response schema at all.

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
  useGeneratedResponseSchemas,
} from "zod-response-oas";
import { responseSchemas } from "./response-schemas.generated.js";

useGeneratedResponseSchemas(responseSchemas); // once, at startup

registerSecurityScheme({
  name: "jwt",
  scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
});

const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  secureWith: ["jwt"],
});

router.get("/:id", {
  summary: "Get a user by ID",
  secure: true,
  handler: getUserById, // named function reference — required for auto response lookup
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

`basePath` is used for the OpenAPI path key only; it does not auto-mount
anything.

## `sendSuccess` / `sendError`

Both take an options object (not positional args) so the compiler catches
mis-ordered fields.

```typescript
sendSuccess(res, {
  data: user, // resource payload (optional)
  message: "User fetched", // optional human-readable message
  others: { requestId: "abc" }, // optional extra TOP-LEVEL body fields
  statusCode: 200, // optional HTTP status (default 200)
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

Runtime note: if `data` is omitted, `JSON.stringify` drops it — the body has
no `data` key. You do **not** need `data: []` / `data: null` just to satisfy
the generator.

```typescript
// Valid — message-only success (e.g. OTP sent)
return sendSuccess(res, {
  message: "OTP sent to your email",
  statusCode: 200,
});
```

`others` is for extra top-level fields that aren't the resource itself
(pagination, counts, request IDs, rate-limit info):

```typescript
sendSuccess(res, {
  data: users,
  others: {
    pagination: { page: 1, totalPages: 5, totalCount: 97 },
  },
});
```

`sendError`:

```typescript
sendError(res, "User not found", {
  statusCode: 404,
  errors: { field: "id", reason: "no matching record" },
});
```

## Inferring responses automatically

```bash
npx zod-response-oas generate \
  --controllers "src/controllers/**/*.ts" \
  --project-root .
```

This writes `response-schemas.generated.ts`: real Zod schemas plus a lookup
map keyed by **handler function name**. Each entry is:

```typescript
{
  schema: z.ZodType | null;
  kind: "data" | "response";
}
```

| `kind`         | Meaning                                          | Router behavior                           |
| -------------- | ------------------------------------------------ | ----------------------------------------- |
| `"data"`       | Schema is the **payload** type only              | Wrapped with `zSuccessResponse(schema)`   |
| `"response"`   | Schema is the **full success envelope**          | Used as-is (no second wrap)               |
| `schema: null` | Confirmed empty success (no data/message/others) | `zSuccessResponse()` with no `data` field |

Wire once at startup:

```typescript
import { useGeneratedResponseSchemas } from "zod-response-oas";
import { responseSchemas } from "./response-schemas.generated.js";

useGeneratedResponseSchemas(responseSchemas);
```

### What gets inferred (per `sendSuccess` call)

Static analysis classifies **each** call site:

| Call shape                                                         | Variant  | Generated `kind`                                               |
| ------------------------------------------------------------------ | -------- | -------------------------------------------------------------- |
| `{ data: T }`                                                      | data     | `"data"` (payload `T`)                                         |
| `{ data: T, message, others }` on **same** call                    | data     | `"data"` (payload `T`; message stays optional on the envelope) |
| `{ message }` and/or `{ others }` only                             | response | `"response"` (full envelope via ts-to-zod)                     |
| `{}` / only `statusCode`                                           | empty    | `{ schema: null, kind: "response" }`                           |
| **Mixed branches** in one handler (some with `data`, some without) | mixed    | `"response"` = `z.union` of full envelopes                     |

Example — both branches are kept:

```typescript
export function getOrEmpty(req, res) {
  if (req.query.empty) {
    return sendSuccess(res, { message: "Nothing found" });
  }
  return sendSuccess(res, { data: { id: "1" } });
}
```

→ one generated entry with `kind: "response"` and a union of the two
envelope shapes (not “data wins, message branch dropped”).

Multiple distinct **data** shapes still become `z.union([...])` with
`kind: "data"`.

### Handler naming requirements

Lookup uses `handler.name`. Both of these break matching (warn by default,
or throw if `requireGeneratedResponses: true`):

- **Inline arrows** — `handler: (req, res) => { ... }` is named `"handler"`
  for every route. Always pass a named function from a controller file.
- **HOC wrappers** — `handler: wrapAsync(getUserById)` that returns an
  anonymous function loses the name. Preserve it
  (`Object.defineProperty(wrapped, "name", { value: fn.name })`) or pass
  `response:` explicitly.

Explicit `response:` on a route still means a **data** schema and is wrapped
with `zSuccessResponse`, same as generated `kind: "data"`.

### Strict mode

```typescript
const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  requireGeneratedResponses: true, // missing map entry → throw at startup
});
```

Important distinction:

- **Missing map entry** → unresolved (warn / throw in strict mode).
- **`{ schema: null, kind: "response" }`** → resolved empty success (OK in
  strict mode).

### Failures are partitioned

Generation runs **per handler**. If one controller uses a type `ts-to-zod`
cannot represent, the others are still written; the process then throws
listing every failed handler. Fix those routes or pass `response:` —
successful handlers are not wiped.

Regenerate whenever response shapes change (ideally `prebuild` /
`predeploy`).

### Mongoose documents

A nominal `HydratedDocument<T>` is auto-unwrapped to `T` when possible:

```typescript
export function getUser(req, res) {
  const user = await User.findById(req.params.id);
  return sendSuccess(res, { data: user }); // prefers T, not the full document type
}
```

Fully expanded `mongoose.Document<...>` intersections (common at real call
sites without `.lean()` / `.toObject()`) are **not** guessed — extraction
warns and skips that call. Normalize before `sendSuccess`, or pass
`response:` explicitly.

Caveat: declared `T` may still diverge from serialized JSON if you use
virtuals, `populate()`, or schema `transform`s. Verify against real output
when those features are in play.

### Known limitation: named type / interface responses

A `data` value typed only as a **named** `interface` / `type` alias defined
elsewhere often cannot be converted: the temp file handed to `ts-to-zod`
does not include that declaration. Generation fails **loudly** for that
handler (others still succeed). Use an explicit `response:` schema for
those routes until transitive type inclusion exists.

Inline object types, local structural types, and synthetic envelopes
(message / others / mixed) go through `ts-to-zod` normally.

## Automatic path parameter inference

```typescript
router.get("/:id", { handler: getUserById });
// :id → Mongo ObjectId regex by default (*id-suffixed params)
```

Non-id params default to `z.string()`. Override globally or per route:

```typescript
const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  autoParamSchemas: { id: "uuid", "*": "slug" },
});

router.get("/:id/legacy/:legacyId", {
  autoParamSchemas: { legacyId: "number" },
  handler: getLegacyThing,
});
```

Built-ins: `"mongo"`, `"uuid"`, `"ulid"`, `"cuid"`, `"cuid2"`, `"nanoid"`,
`"snowflake"`, `"slug"`, `"number"`, `"string"`, or any Zod schema.
Explicit `params:` disables auto-inference for that route.

## Security schemes

```typescript
registerSecurityScheme({
  name: "jwt",
  scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
});

const router = createSmartRouter({
  basePath: "/api/v1/users",
  tag: "Users",
  secureWith: ["jwt"],
});

router.get("/:id", {
  secure: true, // OpenAPI security only
  middleware: [requireAuth], // actual enforcement
  handler: getUserById,
});
```

`secure: true` does **not** block requests by itself. Routes also get
standard `400` / `401` / `500` error responses in the OpenAPI doc.

## CLI reference

```bash
npx zod-response-oas generate \
  --tsconfig tsconfig.json \
  --controllers "src/controllers/**/*.ts" \
  --output response-shapes.json \
  --schema-output response-schemas.generated.ts \
  --success-helper sendSuccess \
  --project-root . \
  --skip-validation
```

## Status

Corpus-tested across nested objects, arrays, `.map()` projections, unions,
ternaries, **branching `sendSuccess` (including mixed data / message-only)**,
optional/nullable fields, `Record` / index signatures, tuples,
intersections, Mongoose (raw vs normalized), primitives, message-only and
empty successes, and async handlers.

Known limitations:

- Named interface / type-alias-only payloads often need explicit
  `response:` (see above).
- `ts-to-zod` limits (generics, mapped types) fail **per handler** with a
  clear error; other handlers still generate.
- A literal `data: null` can hit a `ts-to-zod` quirk; other primitives are
  fine.
- Multi-file re-runs rewrite the whole generated file (fine for CI).
- Any function that calls `sendSuccess` gets a schema entry — not only
  Express route handlers (usually harmless).
- Static analysis treats a present `message` key as “has message” even if
  the value is `undefined` / `""` (runtime may omit the field).

## What this is not

- Not a request-validation innovation — that part matches prior art on
  purpose.
- Not framework-agnostic (Express-specific for now).
- Not a substitute for reading your OpenAPI output before shipping.
