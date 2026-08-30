import { describe, it, expect, beforeEach } from "vitest";
import {
  createSmartRouter,
  registerSecurityScheme,
  useGeneratedResponseSchemas,
  generateOpenApiDocument,
  openApiRegistry,
} from "../src/index.js";

beforeEach(() => {
  useGeneratedResponseSchemas({});
  (openApiRegistry as any).definitions.length = 0;
});

describe("security schemes and standard error responses", () => {
  it("a secure:true route with a matching secureWith scheme gets the expected 'security' block", () => {
    registerSecurityScheme({
      name: "jwt",
      scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    });

    const router = createSmartRouter({
      basePath: "/s1",
      tag: "T",
      secureWith: ["jwt"],
    });
    router.get("/thing", {
      secure: true,
      handler: function getThing(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    expect(doc.paths["/s1/thing"].get!.security).toEqual([{ jwt: [] }]);
    expect((doc.components as any).securitySchemes.jwt).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
  });

  it("a route with secure: false (or omitted) has NO security block, even with secureWith configured", () => {
    registerSecurityScheme({
      name: "jwt",
      scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    });

    const router = createSmartRouter({
      basePath: "/s2",
      tag: "T",
      secureWith: ["jwt"],
    });
    router.get("/thing", { handler: function getThing(req: any, res: any) {} }); // secure omitted

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    expect(doc.paths["/s2/thing"].get!.security).toBeUndefined();
  });

  it("secure: true with NO secureWith configured on the router produces no security block (nothing to require)", () => {
    const router = createSmartRouter({ basePath: "/s3", tag: "T" }); // no secureWith
    router.get("/thing", {
      secure: true,
      handler: function getThing(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    expect(doc.paths["/s3/thing"].get!.security).toBeUndefined();
  });

  it("IMPORTANT: secure: true does not itself add any request-blocking behavior — it is a docs-only flag", () => {
    // This isn't testing HTTP behavior (that's the Supertest layer), but
    // confirming at the config level that "secure" has no middleware side
    // effect of its own — real auth enforcement must come from the
    // `middleware:` array. Documented here explicitly because assuming
    // `secure: true` alone protects a route would be a real security bug
    // in a consumer's app, not a hypothetical one.
    const router = createSmartRouter({
      basePath: "/s4",
      tag: "T",
      secureWith: ["jwt"],
    });
    router.get("/thing", {
      secure: true,
      handler: function getThing(req: any, res: any) {},
    });

    // No middleware array was ever provided — if "secure" injected auth
    // enforcement itself, this call would need one to make sense. It
    // doesn't, by design: "secure" only affects the generated OpenAPI doc.
    const layer = (router.instance as any).stack[0];
    expect(layer.route.stack).toHaveLength(2); // just [validationMiddleware, handler] — no auth middleware injected
  });

  it("every route always gets 400/401/500 response classes registered, regardless of secure", () => {
    const router = createSmartRouter({ basePath: "/s5", tag: "T" });
    router.get("/thing", { handler: function getThing(req: any, res: any) {} });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const responses = doc.paths["/s5/thing"].get!.responses;

    expect(responses[400]).toBeDefined();
    expect(responses[401]).toBeDefined();
    expect(responses[500]).toBeDefined();
  });

  it("a POST route defaults to a 201 success response; GET defaults to 200", () => {
    const router = createSmartRouter({ basePath: "/s6", tag: "T" });
    router.get("/thing", { handler: function getThing(req: any, res: any) {} });
    router.post("/thing", {
      handler: function createThing(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    expect(doc.paths["/s6/thing"].get!.responses[200]).toBeDefined();
    expect(doc.paths["/s6/thing"].post!.responses[201]).toBeDefined();
  });
});
