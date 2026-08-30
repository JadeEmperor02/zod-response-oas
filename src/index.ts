export {
  createSmartRouter,
  registerSecurityScheme,
  useGeneratedResponseSchemas,
  generateOpenApiDocument,
  inferParamsSchema,
  openApiRegistry,
  type RouteConfig,
  type SmartRouterOptions,
  type SecuritySchemeInput,
  type GenerateDocOptions,
  type ParamStrategy,
  type AutoParamStrategyMap,
} from "./router.js";

export {
  sendSuccess,
  sendError,
  zSuccessResponse,
  zErrorResponse,
  type SendSuccessOptions,
  type SendErrorOptions,
} from "./response.js";

export {
  extractResponseShapes,
  type ExtractResponseShapesOptions,
  type ExtractedShape,
} from "./codegen/extractResponseShapes.js";

export {
  generateZodSchemas,
  type GenerateZodSchemasOptions,
  type GeneratedSchemaResult,
} from "./codegen/generateZodSchemas.js";
