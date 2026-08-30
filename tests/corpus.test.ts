import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractResponseShapes } from "../src/codegen/extractResponseShapes.js";
import { generateZodSchemas } from "../src/codegen/generateZodSchemas.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsconfigPath = path.join(__dirname, "../tsconfig.json");

describe("Controller Corpus Extraction and Generation", () => {
  let tempDir: string;

  beforeAll(() => {
    // Create an isolated temporary directory in system temp folder
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-tests-"));
  });

  afterAll(() => {
    // Clean up temporary directory and all generated files after tests complete
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Test each controller file individually to isolate failures
  const controllers = [
    "01-simple.ts",
    "02-nested.ts",
    "03-list-array.ts",
    "04-mapped.ts",
    "05-typed-interface.ts",
    "06-optional-properties.ts",
    "07-unions.ts",
    "08-ternanry.ts",
    "09-multiple-calls.ts",
    "10-no-data.ts",
    "11-failed-computed-variable.ts",
    "12-fail-spread.ts",
    "13-fail-build-response.ts",
    "14-fail-generic.ts",
    "15-const-arrow.ts",
    "16-message-and-others.ts",
    "17-null-and-primitives.ts",
    "18-as-const-literal.ts",
    "19-array-of-unions.ts",
    "20-record-index-signature.ts",
    "21-readonly-tuple.ts",
    "22-intersection.ts",
    "23-nested-optional-nullable.ts",
    "24.faile-computed-keys.ts",
    "25-mongoose-raw-doc-warning.ts",
    "26-deeply-nested.ts",
    "27-empty-object.ts",
    "28-promise-unwrapped.ts",
  ];

  for (const controller of controllers) {
    it(`should process ${controller}`, () => {
      const controllerPath = path.join(
        __dirname,
        "../src/controllers",
        controller,
      );
      const tempOut = path.join(tempDir, `temp-${controller}.json`);
      const generatedOut = path.join(
        tempDir,
        `temp-${controller}.generated.ts`,
      );

      const shapes = extractResponseShapes({
        tsconfigPath,
        controllerGlobs: [controllerPath],
        outputPath: tempOut,
      });

      expect(shapes.length).toBeGreaterThan(0);

      // Known failure cases that should throw or behave differently
      const knownFailures = [
        "12-fail-spread.ts",
        "13-fail-build-response.ts",
        "17-null-and-primitives.ts",
      ];

      if (knownFailures.includes(controller)) {
        expect(() => {
          generateZodSchemas(shapes, {
            outputPath: generatedOut,
            projectRoot: path.join(__dirname, ".."),
          });
        }).toThrow();
      } else {
        expect(() => {
          generateZodSchemas(shapes, {
            outputPath: generatedOut,
            projectRoot: path.join(__dirname, ".."),
          });
        }).not.toThrow();
      }
    });
  }
});
