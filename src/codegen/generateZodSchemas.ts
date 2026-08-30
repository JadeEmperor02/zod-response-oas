/**
 * Converts extracted response shapes (TypeScript type text, from
 * extractResponseShapes) into real Zod schema source code.
 *
 * This shells out to the `ts-to-zod` CLI rather than importing its
 * internals. Its own README directs programmatic users to
 * `src/core/generate.ts` — that's the maintainer pointing at source for
 * their own reference, not a documented package export covered by semver.
 * A published package depending on that could break on any ts-to-zod patch
 * release with no warning. The CLI is the interface they actually version
 * and test against, so that's the boundary we depend on. This runs once at
 * build time, so the subprocess cost here is irrelevant.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtractedShape } from "./extractResponseShapes.js";

const require = createRequire(import.meta.url);

/**
 * Resolves ts-to-zod's actual bin script from OUR dependency on it, rather
 * than shelling out via `npx ts-to-zod` — npx will silently fetch a fresh
 * copy from the registry if it can't immediately resolve one locally
 * (confirmed during testing), which defeats pinning a version at all.
 * Invoking the resolved script directly with `node` guarantees we run
 * exactly the version declared in this package's own dependencies.
 */
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
  /**
   * Directory containing the consumer's own node_modules (where their real
   * `zod` install lives). ts-to-zod's embedded validation step needs to
   * resolve `zod` to compare its generated schema's inferred type against
   * the original — that only works if the temp working directory sits
   * inside (or under) this directory, so Node's module resolution walks up
   * to find it. Defaults to process.cwd().
   */
  projectRoot?: string;
  /** Skip ts-to-zod's embedded validation step. Not recommended — see ts-to-zod's own docs on the risk. */
  skipValidation?: boolean;
}

export interface GeneratedSchemaResult {
  fileContent: string;
  /** handler name -> generated schema identifier(s). More than one means a branching (oneOf) response. */
  schemaNameByHandler: Record<string, string[]>;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function generateZodSchemas(
  shapes: ExtractedShape[],
  options: GenerateZodSchemasOptions,
): GeneratedSchemaResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  // Nested inside the consumer's own project (not the OS tmpdir) so that
  // Node's module resolution, walking up from here, finds their real
  // node_modules/zod for ts-to-zod's embedded validation step.
  const tmpDir = mkdtempSync(path.join(projectRoot, ".zod-response-oas-tmp-"));
  // ts-to-zod's own CLI resolves its input-path argument with something
  // equivalent to path.join(cwd, arg) rather than path.resolve — confirmed
  // by reproduction — so an absolute path gets nonsensically concatenated
  // onto its cwd instead of overriding it. Passing bare relative filenames
  // with `cwd` set to this directory sidesteps that entirely.
  const inputFile = "shapes.ts";
  const outputFile = "shapes.zod.ts";
  const inputPath = path.join(tmpDir, inputFile);
  const outputPath = path.join(tmpDir, outputFile);

  const schemaNameByHandler: Record<string, string[]> = {};
  const typeLines: string[] = [];

  // ts-to-zod only converts EXPORTED named types/interfaces — an anonymous
  // inline object literal type isn't one, so we synthesize a name for each
  // distinct shape before handing anything to it.
  for (const shape of shapes) {
    const safeHandlerName = shape.handler.replace(/[^a-zA-Z0-9_]/g, "_");
    const names: string[] = [];

    shape.typeTexts.forEach((typeText, i) => {
      const suffix = shape.typeTexts.length > 1 ? String(i) : "";
      const typeName = `${capitalize(safeHandlerName)}Shape${suffix}`;
      // "undefined" (a success response with no `data` field) isn't a
      // convertible exported type on its own — treat "no payload" as an
      // empty object, the closer real-world equivalent for a JSON body.
      const resolvedType = typeText === "undefined" ? "{}" : typeText;
      typeLines.push(`export type ${typeName} = ${resolvedType};`);
      names.push(`${lowerFirst(typeName)}Schema`);
    });

    schemaNameByHandler[shape.handler] = names;
  }

  writeFileSync(inputPath, typeLines.join("\n\n") + "\n");

  try {
    const tsToZodBin = resolveTsToZodBin();
    const args = [tsToZodBin, inputFile, outputFile];
    if (options.skipValidation) args.push("--skipValidation");
    execFileSync(process.execPath, args, {
      stdio: "pipe",
      cwd: tmpDir,
    });
  } catch (err: any) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `ts-to-zod failed to convert one or more extracted shapes into a Zod schema. ` +
        `This usually means a handler's response "data" uses something Zod can't represent ` +
        `(generics, mapped types, function types). Check the handlers listed above for the ` +
        `offending type, and consider giving that response a hand-written schema instead.\n\n` +
        `Underlying error:\n${err.stderr?.toString() ?? err.message}`,
    );
  }

  const generatedSchemaSource = readFileSync(outputPath, "utf-8");

  // Wrap any handler with more than one distinct shape in z.union — a
  // branching success path is real behavior to document, not something to
  // silently collapse to whichever shape happened to be seen first.
  const unionExports: string[] = [];
  const lookupEntries: string[] = [];

  for (const [handler, names] of Object.entries(schemaNameByHandler)) {
    if (names.length === 0) {
      // Every sendSuccess call in this handler was something we couldn't
      // confidently extract (warned about elsewhere) — omit it from the
      // map entirely rather than emitting a broken `handler: undefined,`
      // line. Router-side resolution already treats a missing map entry
      // the same as an unresolved one (warns or throws per strict mode),
      // so this is the correct "we don't know" signal, not a silent gap.
      continue;
    }
    if (names.length > 1) {
      const unionName = `${lowerFirst(handler)}ResponseSchema`;
      unionExports.push(
        `export const ${unionName} = z.union([${names.join(", ")}]);`,
      );
      lookupEntries.push(`  ${handler}: ${unionName},`);
    } else {
      lookupEntries.push(`  ${handler}: ${names[0]},`);
    }
  }

  const fileContent = [
    "// AUTO-GENERATED by zod-response-oas — do not edit by hand.",
    "// Regenerate with: npx zod-response-oas generate",
    "",
    generatedSchemaSource.trim(),
    "",
    "// --- oneOf wrappers for handlers with branching success shapes ---",
    ...unionExports,
    "",
    "// --- lookup map: import { responseSchemas } and use responseSchemas.myHandlerName ---",
    "export const responseSchemas = {",
    ...lookupEntries,
    "};",
    "",
  ].join("\n");

  writeFileSync(options.outputPath, fileContent);
  rmSync(tmpDir, { recursive: true, force: true });

  return { fileContent, schemaNameByHandler };
}
