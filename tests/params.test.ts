import { describe, it, expect, beforeEach } from "vitest";
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

describe("automatic path parameter inference", () => {
  it("an *id-suffixed param gets a 24-char hex regex, not a bare string", () => {
    const router = createSmartRouter({
      basePath: "/p1",
      tag: "T",
      autoParamSchemas: { id: "mongo" },
    });
    router.get("/:id", { handler: function getIt(req: any, res: any) {} });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const params: any = doc.paths["/p1/{id}"].get!.parameters;

    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: "id", in: "path", required: true });
    expect(params[0].schema.pattern).toBe("^[0-9a-fA-F]{24}$");
  });

  it("a param NOT ending in 'id' (e.g. :slug) gets a plain string, no regex", () => {
    const router = createSmartRouter({
      basePath: "/p2",
      tag: "T",
      autoParamSchemas: { id: "mongo" },
    });
    router.get("/by-slug/:slug", {
      handler: function getBySlug(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const params: any = doc.paths["/p2/by-slug/{slug}"].get!.parameters;

    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: "slug",
      in: "path",
      required: true,
    });
    expect(params[0].schema.pattern).toBeUndefined();
  });

  it("a param ending in 'id' but not literally 'id' (e.g. :parentId) also gets the hex regex", () => {
    const router = createSmartRouter({
      basePath: "/p3",
      tag: "T",
      autoParamSchemas: { id: "mongo" },
    });
    router.get("/nested/:parentId", {
      handler: function getNested(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const params: any = doc.paths["/p3/nested/{parentId}"].get!.parameters;

    expect(params[0].schema.pattern).toBe("^[0-9a-fA-F]{24}$");
  });

  it("an explicit params: schema is used as-is and is NOT overwritten by auto-inference", () => {
    // Deliberately the OPPOSITE of what auto-inference would produce for
    // an *id-suffixed param — proves this came from the explicit schema,
    // not a partially-applied auto one.
    const explicitParams = z.object({ id: z.string().min(3).max(5) });

    const router = createSmartRouter({
      basePath: "/p4",
      tag: "T",
      autoParamSchemas: { id: "mongo" },
    });
    router.get("/:id", {
      params: explicitParams,
      handler: function getIt(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const params: any = doc.paths["/p4/{id}"].get!.parameters;

    expect(params[0].schema.pattern).toBeUndefined(); // NOT the hex regex
    expect(params[0].schema.minLength).toBe(3);
    expect(params[0].schema.maxLength).toBe(5);
  });

  it("multiple path params in one route each get their own correctly-inferred schema", () => {
    const router = createSmartRouter({
      basePath: "/p5",
      tag: "T",
      autoParamSchemas: { id: "mongo" },
    });
    router.get("/:parentId/child/:slug", {
      handler: function getChild(req: any, res: any) {},
    });

    const doc = generateOpenApiDocument({
      title: "t",
      version: "1.0.0",
      servers: [],
    });
    const params: any[] =
      doc.paths["/p5/{parentId}/child/{slug}"].get!.parameters!;

    const parentId = params.find((p) => p.name === "parentId");
    const slug = params.find((p) => p.name === "slug");

    expect(parentId.schema.pattern).toBe("^[0-9a-fA-F]{24}$");
    expect(slug.schema.pattern).toBeUndefined();
  });
});
