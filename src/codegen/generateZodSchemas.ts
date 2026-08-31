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

  if (typeLines.length === 0) {
    // Every shape passed in had zero confidently-extracted typeTexts (e.g.
    // the only sendSuccess call in the file was a spread or a non-object
    // argument, both already warned about during extraction). Shelling out
    // to ts-to-zod on an empty input produces a confusing, unrelated
    // "file not found" error from its own internal validation step —
    // failing here first with a clear, specific message is strictly better
    // developer experience for what is otherwise a legitimate, expected
    // failure (uncertainty correctly propagating to a build failure).
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `No confidently-extracted response shapes to convert for: ${shapes
        .map((s) => s.handler)
        .join(", ")}. Check the extraction warnings for these handlers — ` +
        `each one's only sendSuccess call was something the extractor couldn't confidently understand.`,
    );
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

  // ts-to-zod can silently omit a schema for a type it can't resolve —
  // confirmed via reproduction: a `data` value typed as a named alias/
  // interface (e.g. `export type XShape = SomeExternalType;`) resolves to
  // just that NAME in the extractor's output, but the isolated temp file we
  // hand to ts-to-zod never includes SomeExternalType's own declaration
  // (it only exists in the original controller file). ts-to-zod doesn't
  // error in this case — it just emits nothing for that type, with no
  // warning of its own. Without this check, the lookup map below would
  // reference a const that was never generated, and the failure would only
  // surface as a ReferenceError the moment a real server imports this file
  // — the single worst place for this library's core promise to break
  // silently. Every expected identifier is verified against what ts-to-zod
  // ACTUALLY produced before it's ever referenced.
  const missingSchemas: string[] = [];
  for (const names of Object.values(schemaNameByHandler)) {
    for (const name of names) {
      const declaredPattern = new RegExp(`(?:export )?const ${name}\\s*=`);
      if (!declaredPattern.test(generatedSchemaSource)) {
        missingSchemas.push(name);
      }
    }
  }

  if (missingSchemas.length > 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `ts-to-zod silently produced no schema for: ${missingSchemas.join(", ")}. ` +
        `This typically happens when a handler's response "data" is typed as a named ` +
        `interface/type alias that isn't self-contained in isolation (it references another ` +
        `type declared elsewhere in your codebase that couldn't be included here). ` +
        `Give this response an explicit hand-written "response:" schema instead of relying on inference.`,
    );
  }

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
