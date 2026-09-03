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

export interface GeneratedResponseSchemaEntry {
  schema: z.ZodType | null;
  kind: "data" | "response";
}

let generatedResponseSchemas: Record<string, GeneratedResponseSchemaEntry> = {};

/**
 * FIX A: Runtime transformer to strip z.undefined() unions before OpenAPI conversion
 * Transforms z.union([z.undefined(), T]) → T.optional() at runtime
 * Built for Zod 4.x which uses _def.type
 */
function stripUndefinedUnions(schema: unknown): z.ZodTypeAny {
  // Strict validation - throw errors to find the problem
  if (Array.isArray(schema)) {
    throw new Error(
      "[zod-response-oas] RAW ARRAY ENCOUNTERED. Malformed schema detected."
    );
  }

  if (!schema || typeof schema !== "object") {
    throw new Error(
      "[zod-response-oas] NON-ZOD VALUE: " + String(schema)
    );
  }

  const def = (schema as any)._def;

  if (!def) {
    throw new Error(
      "[zod-response-oas] OBJECT WITHOUT _def"
    );
  }

  // Zod 4.x uses _def.type
  const typeName = def.type;
  
  // Log if we encounter a never type
  if (typeName === 'never') {
    console.warn("[stripUndefinedUnions] Encountered z.never() - passing through");
  }

  // Handle unions - strip z.undefined()
  if (typeName === "union") {
    const options: z.ZodTypeAny[] = def.options ?? [];
    
    // If no options, return original
    if (options.length === 0) {
      return schema as z.ZodTypeAny;
    }
    
    const nonUndef = options.filter((o) => {
      const t = (o as any)._def?.type;
      return t !== "undefined";
    });
    
    // If all options were undefined, this shouldn't happen but return z.never()
    if (nonUndef.length === 0) {
      console.warn("[stripUndefinedUnions] Union with only z.undefined() found, returning z.never()");
      return z.never();
    }
    
    // If we filtered out z.undefined() and have exactly one type left, make it optional
    if (nonUndef.length === 1 && nonUndef.length < options.length) {
      return stripUndefinedUnions(nonUndef[0]).optional();
    }
    
    // Multiple non-undefined types: keep as union but recurse
    if (nonUndef.length > 1) {
      const transformed = nonUndef.map(stripUndefinedUnions);
      
      // Check if any transformed type is 'never'
      const hasNever = transformed.some((t) => (t as any)._def?.type === 'never');
      if (hasNever) {
        console.warn("[stripUndefinedUnions] Union contains z.never() after transformation");
        console.warn("Original options:", nonUndef.map((o) => (o as any)._def?.type));
        console.warn("Transformed types:", transformed.map((t) => (t as any)._def?.type));
      }
      
      // Ensure we have at least 2 valid schemas for union
      if (transformed.length < 2) {
        throw new Error(
          "[stripUndefinedUnions] Union transformation resulted in < 2 options"
        );
      }
      return z.union(transformed as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    
    // No filtering happened - return original
    return schema as z.ZodTypeAny;
  }

  // Handle objects - recurse into properties
  if (typeName === "object") {
    const shape = def.shape;
    const next: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(shape)) {
      next[k] = stripUndefinedUnions(v);
    }
    return z.object(next);
  }

  // Handle arrays - recurse into element type
  if (typeName === "array") {
    const elementType = def.element;
    if (!elementType) {
      throw new Error("[zod-response-oas] Array has no element in _def.element");
    }
    return z.array(stripUndefinedUnions(elementType));
  }

  // Handle optional - check if innerType is a union with undefined
  if (typeName === "optional") {
    const inner = def.innerType;
    const innerDef = (inner as any)._def;
    
    // If inner is a union with undefined, unwrap it
    if (innerDef?.type === "union") {
      const options: z.ZodTypeAny[] = innerDef.options ?? [];
      const nonUndef = options.filter((o) => {
        const t = (o as any)._def?.type;
        return t !== "undefined";
      });
      
      // If we have exactly one non-undefined type, use it as optional
      if (nonUndef.length === 1 && nonUndef.length < options.length) {
        return stripUndefinedUnions(nonUndef[0]).optional();
      }
      
      // Multiple non-undefined types: keep as union but recurse
      if (nonUndef.length > 1) {
        const transformed = nonUndef.map(stripUndefinedUnions);
        if (transformed.length < 2) {
          throw new Error(
            "[stripUndefinedUnions] Optional union transformation resulted in < 2 options"
          );
        }
        return z.union(transformed as [z.ZodTypeAny, ...z.ZodTypeAny[]]).optional();
      }
    }
    
    // Normal optional, just recurse
    return stripUndefinedUnions(inner).optional();
  }

  // Handle nullable - recurse into inner type
  if (typeName === "nullable") {
    return stripUndefinedUnions(def.innerType).nullable();
  }
  
  // Handle intersections (.and())
  if (typeName === "intersection") {
    return stripUndefinedUnions(def.left).and(stripUndefinedUnions(def.right));
  }

  // For all other types, return as-is
  return schema as z.ZodTypeAny;
}

export function useGeneratedResponseSchemas(
  schemas: Record<string, GeneratedResponseSchemaEntry>,
) {
  generatedResponseSchemas = schemas;
}

const warnedMissingNames = new Set<string>();
const warnedUnresolvedHandlers = new Set<string>();

function resolveGeneratedResponse(
  handler: RequestHandler,
  routeLabel: string,
  strict: boolean,
): GeneratedResponseSchemaEntry | undefined {
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

  // IMPORTANT:
  // `null` means the handler was successfully inferred and has no data.
  // `undefined` means there is no generated entry for this handler.
  if (!(name in generatedResponseSchemas)) {
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

    return undefined;
  }

  return generatedResponseSchemas[name];
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
  secureWith?: string[];
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

  const register = (
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    config: RouteConfig,
  ) => {
    const mergedSecureWith = config.secureWith ?? options.secureWith ?? [];
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
    const resolvedEntry = config.response
      ? ({
          schema: config.response,
          kind: "data",
        } as GeneratedResponseSchemaEntry)
      : resolveGeneratedResponse(
          config.handler,
          fullPath,
          options.requireGeneratedResponses ?? false,
        );

    let successSchema: z.ZodTypeAny;
    
    if (resolvedEntry === undefined) {
      successSchema = z.any();
    } else if (resolvedEntry.schema === null) {
      successSchema = zSuccessResponse();
    } else {
      // Apply transformer BEFORE wrapping
      const cleanedSchema = stripUndefinedUnions(resolvedEntry.schema);
      
      if (resolvedEntry.kind === "response") {
        // Response schemas are already wrapped, clean the whole thing
        successSchema = stripUndefinedUnions(cleanedSchema);
      } else {
        // kind === "data" - wrap the cleaned schema and clean the wrapper too
        const wrapped = zSuccessResponse(cleanedSchema);
        successSchema = stripUndefinedUnions(wrapped);
      }
    }

    openApiRegistry.registerPath({
      method,
      path: openApiPath,
      summary: config.summary,
      description: config.description,
      tags: config.tags || [options.tag],
      ...(config.secure &&
        mergedSecureWith.length > 0 && {
          security: [Object.fromEntries(mergedSecureWith.map((s) => [s, []]))],
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
