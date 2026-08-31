import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  ExtractedShape,
  ResponseVariant,
} from "./extractResponseShapes.js";

const require = createRequire(import.meta.url);

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
    "};",
    "",
  ].join("\n");

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

  const names: string[] = [];
  const typeLines: string[] = [];

  typeTexts.forEach((typeText, i) => {
    const suffix = typeTexts.length > 1 ? String(i) : "";
    const typeName = `${capitalize(safeHandlerName)}Shape${suffix}`;
    typeLines.push(`export type ${typeName} = ${typeText};`);
    names.push(`${lowerFirst(typeName)}Schema`);
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

    const generatedSchemaSource = readFileSync(outputPath, "utf-8");

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
      schemaSource: generatedSchemaSource.trim(),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
