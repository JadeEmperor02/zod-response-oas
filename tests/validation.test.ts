import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import z from "zod";
import {
  createSmartRouter,
  sendSuccess,
  useGeneratedResponseSchemas,
  openApiRegistry,
} from "../src/index.js";

beforeEach(() => {
  useGeneratedResponseSchemas({});
  (openApiRegistry as any).definitions.length = 0;
});

function buildApp(
  configureRoutes: (router: ReturnType<typeof createSmartRouter>) => void,
) {
  const router = createSmartRouter({
    basePath: "/api",
    tag: "T",
    autoParamSchemas: { id: "mongo" },
  });
  configureRoutes(router);
  const app = express();
  app.use(express.json());
  // basePath is used for the OpenAPI doc path key ONLY — the router
  // registers routes at their bare relative path internally, so it must be
  // mounted at the SAME basePath here or every route 404s despite the
  // OpenAPI doc looking entirely correct. Standard Express sub-router
  // convention, but easy to miss since basePath already appears in the
  // router config, which can read as "already handled."
  app.use("/api", router.instance);
  return app;
}

describe("HTTP-level request validation (real Express + Supertest)", () => {
  it("a valid body passes through to the handler and gets the expected sendSuccess envelope", async () => {
    const app = buildApp((router) => {
      router.post("/users", {
        body: z.object({ name: z.string(), age: z.number() }),
        handler: function createUser(req, res) {
          return sendSuccess(res, { data: req.body, statusCode: 201 });
        },
      });
    });

    const response = await request(app)
      .post("/api/users")
      .send({ name: "Jade", age: 30 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      ok: true,
      success: true,
      data: { name: "Jade", age: 30 },
    });
  });

  it("an invalid body returns 400 with the standard validation-error envelope, handler never runs", async () => {
    let handlerCalled = false;
    const app = buildApp((router) => {
      router.post("/users", {
        body: z.object({ name: z.string(), age: z.number() }),
        handler: function createUser(req, res) {
          handlerCalled = true;
          return sendSuccess(res, { data: req.body });
        },
      });
    });

    const response = await request(app)
      .post("/api/users")
      .send({ name: "Jade", age: "not-a-number" });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.msg).toBe("Validation error");
    expect(response.body.errors).toBeDefined();
    expect(handlerCalled).toBe(false);
  });

  it("the middleware REPLACES req.body with the parsed/coerced result, not just validates it", async () => {
    const app = buildApp((router) => {
      router.post("/users", {
        // z.coerce.number() turns a JSON string "30" into an actual number —
        // proving the handler receives the parsed value requires this,
        // since a JSON body can only ever send "30" as a string over HTTP.
        body: z.object({ name: z.string(), age: z.coerce.number() }),
        handler: function createUser(req, res) {
          return sendSuccess(res, {
            data: { age: req.body.age, ageType: typeof req.body.age },
          });
        },
      });
    });

    const response = await request(app)
      .post("/api/users")
      .send({ name: "Jade", age: "30" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ age: 30, ageType: "number" });
  });

  it("an invalid :id path param (not 24-char hex) returns 400 with the params-validation envelope", async () => {
    const app = buildApp((router) => {
      router.get("/users/:id", {
        handler: function getUser(req, res) {
          return sendSuccess(res, { data: { id: req.params.id } });
        },
      });
    });

    const response = await request(app).get("/api/users/not-a-valid-id");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.msg).toBe("Params validation error");
  });

  it("a valid 24-char hex :id passes through and reaches the handler", async () => {
    const app = buildApp((router) => {
      router.get("/users/:id", {
        handler: function getUser(req, res) {
          return sendSuccess(res, { data: { id: req.params.id } });
        },
      });
    });

    const validId = "507f1f77bcf86cd799439011"; // 24 hex chars
    const response = await request(app).get(`/api/users/${validId}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: validId });
  });

  it("an invalid query parameter returns 400 with the query-validation envelope", async () => {
    const app = buildApp((router) => {
      router.get("/users", {
        query: z.object({ limit: z.coerce.number().max(100) }),
        handler: function listUsers(req, res) {
          return sendSuccess(res, { data: [] });
        },
      });
    });

    const response = await request(app)
      .get("/api/users")
      .query({ limit: "9999" });

    expect(response.status).toBe(400);
    expect(response.body.msg).toBe("Query parameter validation error");
  });

  it("secure: true alone does NOT block an unauthenticated request — confirms it's a docs-only flag over real HTTP, not just at the config level", async () => {
    const app = buildApp((router) => {
      router.get("/protected", {
        secure: true, // deliberately no auth middleware attached
        handler: function getProtected(req, res) {
          return sendSuccess(res, { data: { secret: "visible without auth" } });
        },
      });
    });

    // No Authorization header sent at all.
    const response = await request(app).get("/api/protected");

    expect(response.status).toBe(200);
    expect(response.body.data.secret).toBe("visible without auth");
  });

  it("middleware array IS what actually enforces auth — a route with real auth middleware DOES block", async () => {
    const app = buildApp((router) => {
      const requireAuth = (req: any, res: any, next: any) => {
        if (!req.headers.authorization) {
          return res
            .status(401)
            .json({ ok: false, success: false, msg: "Unauthorized" });
        }
        next();
      };

      router.get("/protected", {
        secure: true,
        middleware: [requireAuth],
        handler: function getProtected(req, res) {
          return sendSuccess(res, { data: { secret: "only with auth" } });
        },
      });
    });

    const withoutAuth = await request(app).get("/api/protected");
    expect(withoutAuth.status).toBe(401);

    const withAuth = await request(app)
      .get("/api/protected")
      .set("Authorization", "Bearer token");
    expect(withAuth.status).toBe(200);
  });
});
