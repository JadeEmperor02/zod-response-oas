#!/usr/bin/env node
import { extractResponseShapes } from "../dist/codegen/extractResponseShapes.js";
import { generateZodSchemas } from "../dist/codegen/generateZodSchemas.js";

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : fallback;
}

if (command === "generate") {
  const tsconfigPath = getFlag("tsconfig", "tsconfig.json");
  const controllerGlobs = getFlag("controllers", "src/controllers/**/*.ts");
  const shapesOutputPath = getFlag("output", "response-shapes.json");
  const schemaOutputPath = getFlag(
    "schema-output",
    "response-schemas.generated.ts",
  );
  const successHelperName = getFlag("success-helper", "sendSuccess");
  const projectRoot = getFlag("project-root", process.cwd());
  const skipValidation = args.includes("--skip-validation");

  const results = extractResponseShapes({
    tsconfigPath,
    controllerGlobs,
    outputPath: shapesOutputPath,
    successHelperName,
  });

  const withWarnings = results.filter((r) => r.warnings.length > 0);
  const withMultipleShapes = results.filter((r) => r.typeTexts.length > 1);

  console.log(
    `Extracted response shapes for ${results.length} handler(s) → ${shapesOutputPath}`,
  );
  if (withMultipleShapes.length > 0) {
    console.log(
      `\n${withMultipleShapes.length} handler(s) have branching response shapes (rendered as oneOf):`,
    );
    for (const r of withMultipleShapes)
      console.log(`  ${r.file} :: ${r.handler}`);
  }
  if (withWarnings.length > 0) {
    console.log(`\n${withWarnings.length} handler(s) have warnings:`);
    for (const r of withWarnings) {
      console.log(`  ${r.file} :: ${r.handler}`);
      for (const w of r.warnings) console.log(`    - ${w}`);
    }
  }

  if (results.length === 0) {
    console.log("\nNo response shapes found — skipping schema generation.");
    process.exit(0);
  }

  console.log(`\nConverting extracted shapes to Zod schemas via ts-to-zod...`);
  try {
    generateZodSchemas(results, {
      outputPath: schemaOutputPath,
      projectRoot,
      skipValidation,
    });
    console.log(`Zod schemas written to ${schemaOutputPath}`);
    console.log(
      `\nImport { responseSchemas } from "./${schemaOutputPath.replace(/\.ts$/, "")}" and pass ` +
        `responseSchemas.<handlerName> as a route's "response" — no schema to hand-write.`,
    );
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
} else {
  console.log(
    `Usage: zod-response-oas generate [--tsconfig <path>] [--controllers <glob>] [--output <path>] [--schema-output <path>] [--success-helper <name>] [--project-root <path>] [--skip-validation]`,
  );
  process.exit(command ? 1 : 0);
}
