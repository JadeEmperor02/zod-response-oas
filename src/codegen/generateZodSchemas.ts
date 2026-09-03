import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  ExtractedShape,
  ResponseVariant,
} from "./extractResponseShapes.js";

const require = createRequire(import.meta.url);

export function ensureParentDirectory(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveTsToZodBin(): string {
  const pkgJsonPath = require.resolve("ts-to-zod/package.json");
  const pkgDir = path.dirname(pkgJsonPath);
  const pkg = require(pkgJsonPath);
  const binField = pkg.bin;
  const relBin =
    typeof binField === "string"
      ? binField
      : (Object.values(binField)[0] as string);
  return path.join(pkgDir, relBin);
}

export interface GenerateZodSchemasOptions {
  outputPath: string;
  projectRoot?: string;
  skipValidation?: boolean;
}

export interface GeneratedSchemaResult {
  fileContent: string;
  /** handler name -> generated schema identifier(s). More than one => branching (oneOf). */
  schemaNameByHandler: Record<string, string[]>;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function safeName(handler: string) {
  return handler.replace(/[^a-zA-Z0-9_]/g, "_");
}
function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function envelopeTypeText(
  hasMessage: boolean,
  othersTypeTexts: string[],
): string {
  const fields = [
    "success: true",
    "ok: true",
    hasMessage ? "message: string" : "message?: string",
    ...othersTypeTexts,
  ];
  return `{\n  ${fields.join(";\n  ")}\n}`;
}

function envelopeTypeTextWithData(
  dataTypeText: string,
  hasMessage: boolean,
  othersTypeTexts: string[],
): string {
  const fields = [
    "success: true",
    "ok: true",
    hasMessage ? "message: string" : "message?: string",
    `data: ${dataTypeText}`,
    ...othersTypeTexts,
  ];
  return `{\n  ${fields.join(";\n  ")}\n}`;
}

export function generateZodSchemas(
  shapes: ExtractedShape[],
  options: GenerateZodSchemasOptions,
): GeneratedSchemaResult {
  const schemaNameByHandler: Record<string, string[]> = {};
  const successfulSchemaSource: string[] = [];
  const failures: { handler: string; error: string }[] = [];
  const noDataHandlers = new Set<string>();
  const responseSchemaKinds: Record<string, "data" | "response"> = {};

  for (const shape of shapes) {
    if (shape.warnings.length > 0 && shape.variants.length === 0) {
      failures.push({
        handler: shape.handler,
        error: shape.warnings.join("; "),
      });
      continue;
    }

    if (shape.variants.length === 0) {
      continue;
    }

    const onlyEmpty = shape.variants.every((v) => v.kind === "empty");
    const onlyData = shape.variants.every((v) => v.kind === "data");
    const onlyResponseLevel =
      shape.variants.every(
        (v) => v.kind === "response" || v.kind === "empty",
      ) && !onlyEmpty;

    try {
      if (onlyEmpty) {
        schemaNameByHandler[shape.handler] = [];
        noDataHandlers.add(shape.handler);
        responseSchemaKinds[shape.handler] = "response";
        continue;
      }

      if (onlyData) {
        const typeTexts = unique(
          shape.variants
            .filter(
              (v): v is Extract<ResponseVariant, { kind: "data" }> =>
                v.kind === "data",
            )
            .map((v) => v.dataTypeText),
        );
        const { names, schemaSource } = convertTypeTexts(
          typeTexts,
          safeName(shape.handler),
          options,
        );
        schemaNameByHandler[shape.handler] = names;
        responseSchemaKinds[shape.handler] = "data";
        successfulSchemaSource.push(schemaSource);
        continue;
      }

      if (onlyResponseLevel) {
        const envelopeTexts = unique(
          shape.variants
            .filter(
              (v): v is Extract<ResponseVariant, { kind: "response" }> =>
                v.kind === "response",
            )
            .map((v) => envelopeTypeText(v.hasMessage, v.othersTypeTexts)),
        );
        // If the only non-empty path was somehow empty set (shouldn't happen),
        // treat as no-data rather than calling ts-to-zod with zero types.
        if (envelopeTexts.length === 0) {
          schemaNameByHandler[shape.handler] = [];
          noDataHandlers.add(shape.handler);
          responseSchemaKinds[shape.handler] = "response";
          continue;
        }
        const { names, schemaSource } = convertTypeTexts(
          envelopeTexts,
          `${safeName(shape.handler)}Response`,
          options,
        );
        schemaNameByHandler[shape.handler] = names;
        responseSchemaKinds[shape.handler] = "response";
        successfulSchemaSource.push(schemaSource);
        continue;
      }

      // MIXED: data + message/others/empty → full envelopes, kind "response"
      const envelopeTexts = unique(
        shape.variants.map((v) => {
          if (v.kind === "data") {
            return envelopeTypeTextWithData(
              v.dataTypeText,
              v.hasMessage,
              v.othersTypeTexts,
            );
          }
          if (v.kind === "response") {
            return envelopeTypeText(v.hasMessage, v.othersTypeTexts);
          }
          return `{ success: true; ok: true; message?: string }`;
        }),
      );

      const { names, schemaSource } = convertTypeTexts(
        envelopeTexts,
        `${safeName(shape.handler)}Response`,
        options,
      );
      schemaNameByHandler[shape.handler] = names;
      responseSchemaKinds[shape.handler] = "response";
      successfulSchemaSource.push(schemaSource);
    } catch (err: any) {
      failures.push({
        handler: shape.handler,
        error: err.stderr?.toString?.() ?? err.message ?? String(err),
      });
    }
  }

  const unionExports: string[] = [];
  const lookupEntries: string[] = [];

  for (const [handler, names] of Object.entries(schemaNameByHandler)) {
    const kind = responseSchemaKinds[handler] ?? "response";

    if (noDataHandlers.has(handler)) {
      lookupEntries.push(`  ${handler}: { schema: null, kind: "${kind}" },`);
      continue;
    }

    if (names.length > 1) {
      const unionName = `${lowerFirst(handler)}ResponseSchema`;
      unionExports.push(
        `export const ${unionName} = z.union([${names.join(", ")}]);`,
      );
      lookupEntries.push(
        `  ${handler}: { schema: ${unionName}, kind: "${kind}" },`,
      );
      continue;
    }

    if (names.length === 1) {
      lookupEntries.push(
        `  ${handler}: { schema: ${names[0]}, kind: "${kind}" },`,
      );
    }
  }

  const fileContent = [
    "// AUTO-GENERATED by zod-response-oas — do not edit by hand.",
    "// Regenerate with: npx zod-response-oas generate",
    "",
    'import z from "zod";',
    "",
    successfulSchemaSource.join("\n\n"),
    "",
    "// --- oneOf wrappers for handlers with branching success shapes ---",
    ...unionExports,
    "",
    "export const responseSchemas = {",
    ...lookupEntries,
    '} satisfies Record<string, { schema: z.ZodType | null; kind: "data" | "response" }>;',
    "",
  ].join("\n");

  ensureParentDirectory(options.outputPath);
  writeFileSync(options.outputPath, fileContent);

  if (failures.length > 0) {
    const detail = failures
      .map((f) => `  - ${f.handler}: ${f.error.trim().split("\n")[0]}`)
      .join("\n");
    throw new Error(
      `zod-response-oas: ${failures.length} handler(s) failed schema generation; ` +
        `successful handlers were still written to ${options.outputPath}.\n` +
        `Fix or pass explicit "response:" for:\n${detail}`,
    );
  }

  return { fileContent, schemaNameByHandler };
}

function stripZodImport(source: string): string {
  return source
    .replace(/^\s*import\s*\{\s*z\s*\}\s*from\s*["']zod["'];?\s*$/gm, "")
    .trim();
}

/**
 * One set of type strings → one temp dir → one ts-to-zod invocation.
 * Does not take ExtractedShape — only the type texts to convert.
 */
function convertTypeTexts(
  typeTexts: string[],
  safeHandlerName: string,
  options: GenerateZodSchemasOptions,
): { names: string[]; schemaSource: string } {
  if (typeTexts.length === 0) {
    throw new Error(
      `convertTypeTexts called with no type texts for ${safeHandlerName}`,
    );
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const tmpDir = mkdtempSync(path.join(projectRoot, ".zod-response-oas-tmp-"));
  const inputFile = "shapes.ts";
  const outputFile = "shapes.zod.ts";
  const inputPath = path.join(tmpDir, inputFile);
  const outputPath = path.join(tmpDir, outputFile);

  const typeNames: string[] = [];
  const typeLines: string[] = [];

  typeTexts.forEach((typeText, i) => {
    const suffix = typeTexts.length > 1 ? String(i) : "";
    const typeName = `${capitalize(safeHandlerName)}Shape${suffix}`;

    typeLines.push(`export type ${typeName} = ${typeText};`);
    typeNames.push(typeName);
  });

  writeFileSync(inputPath, typeLines.join("\n\n") + "\n");

  try {
    const tsToZodBin = resolveTsToZodBin();
    const args = [tsToZodBin, inputFile, outputFile];
    if (options.skipValidation) args.push("--skipValidation");

    execFileSync(process.execPath, args, {
      stdio: "pipe",
      cwd: tmpDir,
    });

    const generatedSchemaSource = scrubUndefinedUnionsInZodSource(
      readFileSync(outputPath, "utf-8"),
    );

    const generatedNames = [
      ...generatedSchemaSource.matchAll(
        /export const ([A-Za-z_$][A-Za-z0-9_$]*Schema)\s*=/g,
      ),
    ].map((match) => match[1]);

    if (generatedNames.length !== typeNames.length) {
      throw new Error(
        `ts-to-zod generated ${generatedNames.length} schema(s) for ` +
          `${typeNames.length} type(s): ${typeNames.join(", ")}`,
      );
    }

    const names = generatedNames;

    const unsupportedRuntimeRefs = [
      "mongoose.",
      "HydratedDocument",
      "mongoose.Document",
    ];

    const badRef = unsupportedRuntimeRefs.find((ref) =>
      generatedSchemaSource.includes(ref),
    );

    if (badRef) {
      throw new Error(
        `ts-to-zod generated an unresolved runtime reference "${badRef}" ` +
          `for ${safeHandlerName}. This type depends on a library-specific ` +
          `TypeScript helper that cannot be represented safely in isolation. ` +
          `Normalize the response value (.toObject(), .lean(), etc.) or pass "response:" explicitly.`,
      );
    }

    const missing = names.filter(
      (name) =>
        !new RegExp(`(?:export )?const ${name}\\s*=`).test(
          generatedSchemaSource,
        ),
    );

    if (missing.length > 0) {
      throw new Error(
        `ts-to-zod silently produced no schema for: ${missing.join(", ")}. ` +
          `Named type likely isn't self-contained — pass "response:" explicitly.`,
      );
    }

    return {
      names,
      schemaSource: stripZodImport(generatedSchemaSource),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function scrubUndefinedUnionsInZodSource(src: string): string {
  let out = src;
  let prev = "";
  // Repeat until stable — nested unions need multiple passes
  while (out !== prev) {
    prev = out;
    // z.union([z.undefined(), T]).optional() → T.optional()
    out = out.replace(
      /z\.union\(\[\s*z\.undefined\(\)\s*,\s*([\s\S]*?)\s*\]\)\.optional\(\)/g,
      (_, inner) => {
        const parts = splitTopLevelArgs(inner); // or simple path if T has no commas in z.xxx()
        if (parts.length === 1) return `${parts[0].trim()}.optional()`;
        return `z.union([${parts.join(", ")}]).optional()`;
      },
    );
    // z.union([T, z.undefined()]).optional()
    out = out.replace(
      /z\.union\(\[\s*([\s\S]*?)\s*,\s*z\.undefined\(\)\s*\]\)\.optional\(\)/g,
      (_, inner) => {
        const parts = splitTopLevelArgs(inner);
        if (parts.length === 1) return `${parts[0].trim()}.optional()`;
        return `z.union([${parts.join(", ")}]).optional()`;
      },
    );
    // Same without trailing .optional()
    out = out.replace(
      /z\.union\(\[\s*z\.undefined\(\)\s*,\s*([\s\S]*?)\s*\]\)/g,
      (_, inner) => {
        const parts = splitTopLevelArgs(inner);
        if (parts.length === 1) return `${parts[0].trim()}.optional()`;
        return `z.union([${parts.join(", ")}]).optional()`;
      },
    );
    out = out.replace(
      /z\.union\(\[\s*([\s\S]*?)\s*,\s*z\.undefined\(\)\s*\]\)/g,
      (_, inner) => {
        const parts = splitTopLevelArgs(inner);
        if (parts.length === 1) return `${parts[0].trim()}.optional()`;
        return `z.union([${parts.join(", ")}]).optional()`;
      },
    );
  }
  return out;
}

/** Split on commas at depth 0 (respect nested [], (), {}) */
function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}
