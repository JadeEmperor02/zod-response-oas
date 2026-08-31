import { describe, it, expect, beforeEach, vi } from "vitest";
import z from "zod";
import {
  createSmartRouter,
  useGeneratedResponseSchemas,
  generateOpenApiDocument,
  openApiRegistry,
} from "../src/index.js";

beforeEach(() => {
  useGeneratedResponseSchemas({});
  (openApiRegistry as any).definitions.length = 0;
});

describe("response resolution", () => {
  it("explicit response: wins even when a generated schema with the same handler name exists", () => {
    const generatedSchema = z.object({ fromGenerated: z.literal(true) });
    useGeneratedResponseSchemas({ getThing: { schema: generatedSchema, kind: 'data' } });

    const explicitSchema = z.object({ fromExplicit: z.literal(true) });
    function getThing(req: any, res: any) {}

    const router = createSmartRouter({ basePath: "/r1", tag: "T" });
    router.get("/thing", { response: explicitSchema, handler: getThing });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const schema: any =
      doc.paths["/r1/thing"].get!.responses[200].content["application/json"]
        .schema;

    expect(schema.properties.data.properties.fromExplicit).toBeDefined();
    expect(schema.properties.data.properties.fromGenerated).toBeUndefined();
  });

  it("resolves the generated schema by handler.name when no explicit response is given", () => {
    const generatedSchema = z.object({ resolvedViaName: z.literal(true) });
    useGeneratedResponseSchemas({ getThing: { schema: generatedSchema, kind: 'data' } });

    function getThing(req: any, res: any) {}

    const router = createSmartRouter({ basePath: "/r2", tag: "T" });
    router.get("/thing", { handler: getThing });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const schema: any =
      doc.paths["/r2/thing"].get!.responses[200].content["application/json"]
        .schema;

    expect(schema.properties.data.properties.resolvedViaName).toBeDefined();
  });

  it("non-strict: an unresolvable handler name warns and falls back to a permissive schema, without throwing", () => {
    useGeneratedResponseSchemas({
      someOtherHandler: { schema: z.object({ x: z.string() }), kind: 'data' },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    function unknownHandler(req: any, res: any) {}
    const router = createSmartRouter({ basePath: "/r3", tag: "T" });

    expect(() => {
      router.get("/", { handler: unknownHandler });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'no generated schema found for handler "unknownHandler"',
      ),
    );
    warnSpy.mockRestore();
  });

  it("strict: an unresolvable handler name throws at registration time instead of warning", () => {
    useGeneratedResponseSchemas({
      someOtherHandler: { schema: z.object({ x: z.string() }), kind: 'data' },
    });

    function unknownHandler(req: any, res: any) {}
    const router = createSmartRouter({
      basePath: "/r4",
      tag: "T",
      requireGeneratedResponses: true,
    });

    expect(() => {
      router.get("/", { handler: unknownHandler });
    }).toThrow(/no generated schema found for handler "unknownHandler"/);
  });

  it("strict: a thrown registration error leaves no partial OpenAPI or Express route registered", () => {
    useGeneratedResponseSchemas({});
    function unknownHandler(req: any, res: any) {}
    const router = createSmartRouter({
      basePath: "/r5",
      tag: "T",
      requireGeneratedResponses: true,
    });

    expect(() => {
      router.get("/thing", { handler: unknownHandler });
    }).toThrow();

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    expect(doc.paths["/r5/thing"]).toBeUndefined();

    const registeredRoutes = (router.instance as any).stack;
    expect(registeredRoutes).toHaveLength(0);
  });

  it("non-strict: an anonymous handler (no .name) warns and falls back, without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapAsync = (fn: any) => (req: any, res: any, next: any) =>
      fn(req, res, next);

    const router = createSmartRouter({ basePath: "/r6", tag: "T" });
    expect(() => {
      router.get("/", { handler: wrapAsync(function namedInner() {}) });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("handler function has no name"),
    );
    warnSpy.mockRestore();
  });

  it("strict: an anonymous handler (no .name) throws at registration time", () => {
    const wrapAsync = (fn: any) => (req: any, res: any, next: any) =>
      fn(req, res, next);
    const router = createSmartRouter({
      basePath: "/r7",
      tag: "T",
      requireGeneratedResponses: true,
    });

    expect(() => {
      router.get("/", { handler: wrapAsync(function namedInner() {}) });
    }).toThrow(/handler function has no name/);
  });

  it("a wrapper that preserves the original function's name DOES resolve correctly", () => {
    const generatedSchema = z.object({ preserved: z.literal(true) });
    useGeneratedResponseSchemas({ getThing: { schema: generatedSchema, kind: 'data' } });

    function getThing(req: any, res: any) {}
    const wrapAsync = (fn: any) => {
      const wrapped = (req: any, res: any, next: any) => fn(req, res, next);
      Object.defineProperty(wrapped, "name", { value: fn.name });
      return wrapped;
    };

    const router = createSmartRouter({
      basePath: "/r8",
      tag: "T",
      requireGeneratedResponses: true,
    });
    expect(() => {
      router.get("/thing", { handler: wrapAsync(getThing) });
    }).not.toThrow();

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const schema: any =
      doc.paths["/r8/thing"].get!.responses[200].content["application/json"]
        .schema;
    expect(schema.properties.data.properties.preserved).toBeDefined();
  });
});
