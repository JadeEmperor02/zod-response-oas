import type { RequestHandler, Request, Response, NextFunction } from "express";
import { Router } from "express";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import z from "zod";
import { zSuccessResponse, zErrorResponse } from "./response.js";

extendZodWithOpenApi(z);

// One registry per process. If you're building multiple independent APIs
// in the same process, call `resetRegistry()` between them or instantiate
// separate `OpenAPIRegistry` instances yourself and pass them in — most
// users never need to.
export const openApiRegistry = new OpenAPIRegistry();

// Populated once via `useGeneratedResponseSchemas` at app startup. Route
// registration looks a handler's schema up here by `handler.name` so a
// route never has to write `response: responseSchemas.foo` by hand — the
// generated map already has the same key the extractor derived statically.
let generatedResponseSchemas: Record<string, z.ZodType> = {};

/**
 * Wires the generated `responseSchemas` map (from your regenerated
 * response-schemas file) into automatic per-route lookup. Call this once
 * at startup, before registering routes.
 *
 * This relies on `Function.prototype.name`, which JS sets automatically
 * for `const foo = () => {}` / `export function foo() {}` — but NOT for an
 * anonymous function returned by a wrapper, e.g.
 * `wrapAsync(fn)` where `wrapAsync = (fn) => (req, res, next) => ...`.
 * If your handlers pass through such a wrapper before reaching
 * `createSmartRouter`, either make the wrapper preserve the original name
 * (`Object.defineProperty(wrapped, "name", { value: fn.name })`) or pass
 * `response:` explicitly on those routes — auto-injection will warn
 * rather than silently fall back to a permissive schema.
 */
export function useGeneratedResponseSchemas(
  schemas: Record<string, z.ZodType>,
) {
  generatedResponseSchemas = schemas;
}

const warnedMissingNames = new Set<string>();
const warnedUnresolvedHandlers = new Set<string>();

/**
 * A missing generated schema is only a *console warning* by default — that
 * protects a permissive z.any() fallback in dev, but a warning is easy to
 * miss in CI logs. requireGeneratedResponses=true turns the exact same
 * condition into a thrown error at route-registration time (i.e. at server
 * startup, before any request is served) instead. This is the difference
 * between "stale codegen quietly ships a wrong contract" and "stale codegen
 * fails the build" — the latter is what you want once the generate step is
 * wired into your actual build/predeploy pipeline.
 */
function resolveGeneratedResponse(
  handler: RequestHandler,
  routeLabel: string,
  strict: boolean,
): z.ZodType | undefined {
  const name = handler.name;

  if (!name) {
    const message =
      `${routeLabel}: handler function has no name (likely wrapped by a HOC) — ` +
      `can't auto-resolve a generated response schema. Pass "response:" explicitly for this route.`;

    if (strict) {
      throw new Error(`[zod-response-oas] ${message}`);
    }
    if (!warnedMissingNames.has(routeLabel)) {
      warnedMissingNames.add(routeLabel);
      console.warn(`[zod-response-oas] ${message}`);
    }
    return undefined;
  }

  const schema = generatedResponseSchemas[name];
  if (!schema) {
    const message =
      `${routeLabel}: no generated schema found for handler "${name}" — ` +
      `re-run "zod-response-oas generate" if this handler is new, or pass "response:" explicitly.`;

    if (strict) {
      // Unlike the warning path below, strict mode does NOT get the
      // "only if a map was actually provided" exemption — an empty or
      // never-registered map is exactly the failure strict mode exists to
      // catch (e.g. requireGeneratedResponses enabled but codegen never
      // ran, or useGeneratedResponseSchemas never called). Exempting that
      // case would silently defeat strict mode for its most important
      // scenario.
      throw new Error(`[zod-response-oas] ${message}`);
    }
    // Only warn if a generated map was actually provided — if the consumer
    // hasn't called useGeneratedResponseSchemas at all yet, every route
    // would warn, which is noise during initial setup rather than signal.
    if (
      Object.keys(generatedResponseSchemas).length > 0 &&
      !warnedUnresolvedHandlers.has(routeLabel)
    ) {
      warnedUnresolvedHandlers.add(routeLabel);
      console.warn(
        `[zod-response-oas] ${message} Falling back to a permissive response schema.`,
      );
    }
  }

  return schema;
}

export type ParamStrategy =
  | "mongo"
  | "uuid"
  | "ulid"
  | "cuid"
  | "cuid2"
  | "nanoid"
  | "snowflake"
  | "slug"
  | "number"
  | "string"
  | z.ZodTypeAny;

export type AutoParamStrategyMap = Record<string, ParamStrategy>;

function getZodSchemaForStrategy(
  paramName: string,
  strategy: ParamStrategy,
): z.ZodTypeAny {
  if (typeof strategy !== "string") {
    return strategy;
  }

  switch (strategy) {
    case "mongo":
      return z.string().regex(/^[0-9a-fA-F]{24}$/, {
        message: `${paramName} must be a valid MongoDB ObjectId`,
      });
    case "uuid":
      return z.string().uuid({ message: `${paramName} must be a valid UUID` });
    case "ulid":
      return z.string().ulid({ message: `${paramName} must be a valid ULID` });
    case "cuid":
      return z.string().cuid({ message: `${paramName} must be a valid CUID` });
    case "cuid2":
      return z
        .string()
        .cuid2({ message: `${paramName} must be a valid CUID2` });
    case "nanoid":
      return z.string().regex(/^[A-Za-z0-9_-]{21}$/, {
        message: `${paramName} must be a valid NanoID`,
      });
    case "snowflake":
      return z.string().regex(/^\d{17,20}$/, {
        message: `${paramName} must be a valid Snowflake ID`,
      });
    case "slug":
      return z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: `${paramName} must be a valid slug`,
      });
    case "number":
      return z.string().regex(/^\d+$/, {
        message: `${paramName} must be a numeric string`,
      });
    case "string":
    default:
      return z.string();
  }
}

export interface RouteConfig {
  summary?: string;
  description?: string;
  tags?: string[];
  body?: z.ZodType<any>;
  query?: z.ZodObject<any>;
  params?: z.ZodObject<any>;
  middleware?: RequestHandler[];
  handler: RequestHandler;
  /** Set to true if this route requires the security schemes registered via `registerSecurityScheme`. */
  secure?: boolean;
  /**
   * Explicit response schema. Optional — if omitted, the router looks up
   * `handler.name` in the map passed to `useGeneratedResponseSchemas` and
   * uses that automatically. Pass this explicitly to override the
   * generated schema, or when the handler's name can't be relied on (see
   * `useGeneratedResponseSchemas`).
   */
  response?: z.ZodType;
  autoParamSchemas?: AutoParamStrategyMap;
}

export interface SmartRouterOptions {
  basePath: string;
  tag: string;
  /** Names of security schemes (already registered via `registerSecurityScheme`) required on `secure: true` routes. Defaults to none. */
  secureWith?: string[];
  /**
   * When true, a route with no explicit `response:` whose generated schema
   * can't be resolved throws at registration time (server startup) instead
   * of warning and falling back to a permissive schema. Turns "codegen
   * wasn't re-run" into a build failure instead of a silently stale
   * OpenAPI contract. Recommended once `generate` is wired into your build.
   */
  requireGeneratedResponses?: boolean;
  autoParamSchemas?: AutoParamStrategyMap;
}

export function inferParamsSchema(
  path: string,
  strategies: AutoParamStrategyMap = {},
): z.ZodObject<any> | undefined {
  const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(
    (match) => match[1],
  );

  if (params.length === 0) {
    return undefined;
  }

  return z.object(
    Object.fromEntries(
      params.map((name) => {
        let matchedStrategy = strategies[name];

        if (
          !matchedStrategy &&
          name.toLowerCase().endsWith("id") &&
          strategies["id"]
        ) {
          matchedStrategy = strategies["id"];
        }

        if (!matchedStrategy && strategies["*"]) {
          matchedStrategy = strategies["*"];
        }

        const finalSchema = matchedStrategy
          ? getZodSchemaForStrategy(name, matchedStrategy)
          : z.string();
        return [name, finalSchema];
      }),
    ),
  );
}

export interface SecuritySchemeInput {
  name: string;
  scheme:
    | {
        type: "http";
        scheme: "bearer";
        bearerFormat?: string;
        description?: string;
      }
    | {
        type: "apiKey";
        scheme: "cookie" | "header" | "query";
        name: string;
        description?: string;
      };
}

/**
 * Register a security scheme (JWT bearer, cookie, API key, etc.) with the
 * shared OpenAPI registry. Call this once at startup for each scheme your
 * API uses, then reference its `name` in `SmartRouterOptions.secureWith`.
 */
export function registerSecurityScheme(input: SecuritySchemeInput) {
  const { name, scheme } = input;
  openApiRegistry.registerComponent("securitySchemes", name, scheme as any);
}

export function createSmartRouter(options: SmartRouterOptions) {
  const expressRouter = Router();
  const secureWith = options.secureWith ?? [];

  const register = (
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    config: RouteConfig,
  ) => {
    const fullPath = `${options.basePath}${path}`.replace(/\/+/g, "/");
    const openApiPath = fullPath.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");

    // Merge router-wide strategies with route-level overrides
    const mergedStrategies: AutoParamStrategyMap = {
      ...options.autoParamSchemas,
      ...config.autoParamSchemas,
    };

    const autoParamsSchema =
      config.params ?? inferParamsSchema(path, mergedStrategies);

    const validationMiddleware: RequestHandler = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (config.body) {
        const bodyResult = config.body.safeParse(req.body);
        if (!bodyResult.success) {
          return res.status(400).json({
            success: false,
            msg: "Validation error",
            errors: z.treeifyError(bodyResult.error),
          });
        }
        req.body = bodyResult.data;
      }

      if (config.query) {
        const queryResult = config.query.safeParse(req.query);
        if (!queryResult.success) {
          return res.status(400).json({
            success: false,
            msg: "Query parameter validation error",
            errors: z.treeifyError(queryResult.error),
          });
        }
        req.query = queryResult.data as any;
      }

      if (autoParamsSchema) {
        const paramsResult = autoParamsSchema.safeParse(req.params);
        if (!paramsResult.success) {
          return res.status(400).json({
            success: false,
            msg: "Params validation error",
            errors: z.treeifyError(paramsResult.error),
          });
        }
        req.params = paramsResult.data as any;
      }
      return next();
    };

    const successStatusCode = method === "post" ? 201 : 200;
    const resolvedResponse =
      config.response ??
      resolveGeneratedResponse(
        config.handler,
        fullPath,
        options.requireGeneratedResponses ?? false,
      );
    const successSchema = zSuccessResponse(resolvedResponse);

    openApiRegistry.registerPath({
      method,
      path: openApiPath,
      summary: config.summary,
      description: config.description,
      tags: config.tags || [options.tag],
      ...(config.secure &&
        secureWith.length > 0 && {
          security: [Object.fromEntries(secureWith.map((s) => [s, []]))],
        }),
      request: {
        ...(config.body && {
          body: { content: { "application/json": { schema: config.body } } },
        }),
        ...(config.query && { query: config.query as any }),
        ...(autoParamsSchema && { params: autoParamsSchema }),
      },
      responses: {
        [successStatusCode]: {
          description: "Successful operation response payload",
          content: { "application/json": { schema: successSchema } },
        },
        400: {
          description: "Bad Request / validation failure",
          content: { "application/json": { schema: zErrorResponse } },
        },
        401: {
          description: "Unauthorized / missing credentials",
          content: { "application/json": { schema: zErrorResponse } },
        },
        500: {
          description: "Internal server error",
          content: { "application/json": { schema: zErrorResponse } },
        },
      },
    });

    const middlewares = config.middleware || [];

    expressRouter[method](
      path,
      ...middlewares,
      validationMiddleware,
      config.handler,
    );
  };

  return {
    instance: expressRouter,
    get: (path: string, config: RouteConfig) => register("get", path, config),
    post: (path: string, config: RouteConfig) => register("post", path, config),
    put: (path: string, config: RouteConfig) => register("put", path, config),
    patch: (path: string, config: RouteConfig) =>
      register("patch", path, config),
    delete: (path: string, config: RouteConfig) =>
      register("delete", path, config),
  };
}

export interface GenerateDocOptions {
  title: string;
  version: string;
  description?: string;
  servers: { url: string; description?: string }[];
}

export function generateOpenApiDocument(options: GenerateDocOptions) {
  const generator = new OpenApiGeneratorV3(openApiRegistry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: options.title,
      version: options.version,
      description:
        options.description ?? "Auto-generated OpenAPI documentation",
    },
    servers: options.servers,
  });
}
