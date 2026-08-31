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

export const openApiRegistry = new OpenAPIRegistry();

let generatedResponseSchemas: Record<string, z.ZodType> = {};

export function useGeneratedResponseSchemas(
  schemas: Record<string, z.ZodType>,
) {
  generatedResponseSchemas = schemas;
}

const warnedMissingNames = new Set<string>();
const warnedUnresolvedHandlers = new Set<string>();

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
      throw new Error(`[zod-response-oas] ${message}`);
    }
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
  secure?: boolean;
  response?: z.ZodType;
  autoParamSchemas?: AutoParamStrategyMap;
}

export interface SmartRouterOptions {
  basePath: string;
  tag: string;
  secureWith?: string[];
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
        const looksLikeId = name.toLowerCase().endsWith("id");

        if (!matchedStrategy && looksLikeId) {
          // "mongo" is the built-in default for any *id-suffixed param —
          // this library originated in a Mongoose-heavy codebase, and that
          // remains the most common case for its actual audience. A
          // consumer whose IDs are UUIDs (or anything else) overrides this
          // GLOBALLY with autoParamSchemas: { id: "uuid" } — that already
          // takes precedence here; "mongo" is only the fallback when no
          // such override was configured.
          matchedStrategy = strategies["id"] ?? "mongo";
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
