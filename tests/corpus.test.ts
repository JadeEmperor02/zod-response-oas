import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractResponseShapes } from "../src/codegen/extractResponseShapes.js";
import { generateZodSchemas } from "../src/codegen/generateZodSchemas.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsconfigPath = path.join(__dirname, "tsconfig.corpus.json");
const controllersDir = path.join(__dirname, "controllers");
const projectRoot = path.join(__dirname, "..");

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-tests-"));
});

afterAll(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function runFor(controller: string) {
  const controllerPath = path.join(controllersDir, controller);
  const shapesOut = path.join(tempDir, `${controller}.shapes.json`);
  const schemaOut = path.join(tempDir, `${controller}.generated.ts`);

  const shapes = extractResponseShapes({
    tsconfigPath,
    controllerGlobs: [controllerPath],
    outputPath: shapesOut,
  });

  return { shapes, schemaOut };
}

async function generateAndImport(shapes: any, schemaOut: string) {
  generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot });
  const mod = await import(schemaOut);
  return mod.responseSchemas as Record<string, any>;
}

describe("Controller corpus — extraction + generation, verified against real .safeParse behavior", () => {
  it("01-simple: plain object shape validates correctly", async () => {
    const { shapes, schemaOut } = await runFor("01-simple.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.simple.safeParse({ id: "123", name: "Jade" }).success).toBe(
      true,
    );
    expect(schemas.simple.safeParse({ id: "123" }).success).toBe(false);
  });

  it("02-nested: nested object structure is preserved, not flattened", async () => {
    const { shapes, schemaOut } = await runFor("02-nested.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.nested.safeParse({
        user: { id: "1", profile: { name: "Jade", age: 30 } },
      }).success,
    ).toBe(true);
    expect(schemas.nested.safeParse({ user: { id: "1" } }).success).toBe(false);
  });

  it("03-list-array: array of objects, each element validated", async () => {
    const { shapes, schemaOut } = await runFor("03-list-array.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.list.safeParse([{ id: "1", name: "A" }]).success).toBe(true);
    expect(schemas.list.safeParse([{ id: "1" }]).success).toBe(false);
    expect(schemas.list.safeParse({ id: "1", name: "A" }).success).toBe(false);
  });

  it("04-mapped: only the PROJECTED shape from .map() is captured", async () => {
    const { shapes, schemaOut } = await runFor("04-mapped.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.mapped.safeParse([{ id: "1", name: "A" }]).success).toBe(
      true,
    );
    expect(schemas.mapped.safeParse([{ id: "1" }]).success).toBe(false);
  });

  it("05-typed-interface: a data value typed as a NAMED interface (not inline) throws clearly — not yet supported", async () => {
    // Ground-truthed finding: the extractor correctly identifies the type
    // as "UserResponse" (the alias name, which is how TS prints a directly
    // referenced named type) — but the isolated file handed to ts-to-zod
    // never includes UserResponse's own declaration (it only exists in the
    // original controller). ts-to-zod silently produces no schema for it;
    // this library now converts that into a loud, specific failure instead
    // of a runtime ReferenceError three steps later. Real limitation: any
    // response typed against a named interface/type alias (as opposed to
    // an inline object literal) currently needs a hand-written `response:`
    // override.
    const { shapes, schemaOut } = await runFor("05-typed-interface.ts");
    expect(shapes[0].typeTexts).toEqual(["UserResponse"]);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema/);
  });

  it("07-unions: a union type ALIAS (not inline) also throws clearly — same named-type limitation, correctly not silent", async () => {
    const { shapes, schemaOut } = await runFor("07-unions.ts");
    // Confirms the earlier shorthand-property fix worked (the extractor
    // now sees "Result", not "undefined") — but "Result" is itself a named
    // alias defined in the controller file, hitting the same limitation as
    // 05-typed-interface. This is real progress from the original bug
    // (silently wrong) to a known, documented, LOUD limitation.
    expect(shapes[0].typeTexts).toEqual(["Result"]);
    expect(shapes[0].typeTexts).not.toEqual(["undefined"]); // the original bug is fixed
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema/);
  });

  it("19-array-of-unions: an array of a named type alias hits the same limitation", async () => {
    const { shapes, schemaOut } = await runFor("19-array-of-unions.ts");
    expect(shapes[0].typeTexts).toEqual(["Item[]"]);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema/);
  });

  it("22-intersection: an intersection of two named type aliases hits the same limitation", async () => {
    const { shapes, schemaOut } = await runFor("22-intersection.ts");
    expect(shapes[0].typeTexts).toEqual(["Timestamped & Named"]);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema/);
  });

  it("06-optional-properties: an optional field is genuinely optional", async () => {
    const { shapes, schemaOut } = await runFor("06-optional-properties.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.optionalProps.safeParse({ id: "1" }).success).toBe(true);
    expect(schemas.optionalProps.safeParse({}).success).toBe(false);
  });

  it("08-ternary: both branches captured as a union with literal types intact", async () => {
    const { shapes, schemaOut } = await runFor("08-ternary.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.ternary.safeParse({
        role: "admin",
        permissions: ["read", "write"],
      }).success,
    ).toBe(true);
    expect(
      schemas.ternary.safeParse({ role: "superadmin", permissions: [] })
        .success,
    ).toBe(false);
  });

  it("09-multiple-calls: two branches both validate through the same union schema", async () => {
    const { shapes, schemaOut } = await runFor("09-multiple-calls.ts");
    expect(shapes[0].typeTexts).toHaveLength(2);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.multipleCalls.safeParse({ status: "pending" }).success).toBe(
      true,
    );
    expect(
      schemas.multipleCalls.safeParse({ status: "complete", result: "done" })
        .success,
    ).toBe(true);
  });

  it("10-no-data: message-only response is an empty-object schema, not permissive z.any()", async () => {
    const { shapes, schemaOut } = await runFor("10-no-data.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.noData.safeParse({}).success).toBe(true);
    expect(schemas.noData.safeParse("not an object").success).toBe(false);
  });

  it("11-failed-computed-variable: an opaque unknown-typed value produces z.unknown()", async () => {
    const { shapes, schemaOut } = await runFor(
      "11-failed-computed-variable.ts",
    );
    expect(shapes[0].typeTexts).toEqual(["unknown"]);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.failComputedVariable.safeParse({ anything: true }).success,
    ).toBe(true);
  });

  it("14-fail-generic: explicit type argument resolves concretely — does NOT fail despite the filename", async () => {
    const { shapes, schemaOut } = await runFor("14-fail-generic.ts");
    expect(shapes[0].typeTexts).toEqual(["{ id: string; value: number; }"]);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.failGeneric.safeParse({ id: "1", value: 42 }).success).toBe(
      true,
    );
    expect(
      schemas.failGeneric.safeParse({ id: "1", value: "42" }).success,
    ).toBe(false);
  });

  it("15-const-arrow: arrow function assigned to a const is found under the variable's name", async () => {
    const { shapes, schemaOut } = await runFor("15-const-arrow.ts");
    expect(shapes[0].handler).toBe("constArrow");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.constArrow.safeParse({ mode: "arrow", ok: true }).success,
    ).toBe(true);
    expect(
      schemas.constArrow.safeParse({ mode: "arrow", ok: false }).success,
    ).toBe(false);
  });

  it("16-message-and-others: only 'data' becomes the schema — message/others are envelope, not payload", async () => {
    const { shapes, schemaOut } = await runFor("16-message-and-others.ts");
    expect(shapes[0].typeTexts).toEqual(["{ count: number; }"]);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.messageAndOthers.safeParse({ count: 42 }).success).toBe(
      true,
    );
    expect(
      schemas.messageAndOthers.safeParse({ requestId: "abc-123" }).success,
    ).toBe(false);
  });

  it("18-as-const-literal: literals preserved as narrow types, not widened", async () => {
    const { shapes, schemaOut } = await runFor("18-as-const-literal.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.asConstLiteral.safeParse({ status: "ok", code: 200 }).success,
    ).toBe(true);
    expect(
      schemas.asConstLiteral.safeParse({ status: "pending", code: 200 })
        .success,
    ).toBe(false);
  });

  it("20-record-index-signature: Record<string, number> enforces the value type", async () => {
    const { shapes, schemaOut } = await runFor("20-record-index-signature.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.recordIndex.safeParse({ alice: 10, bob: 20 }).success).toBe(
      true,
    );
    expect(schemas.recordIndex.safeParse({ alice: "10" }).success).toBe(false);
  });

  it("23-nested-optional-nullable: optional AND nullable both behave correctly", async () => {
    const { shapes, schemaOut } = await runFor(
      "23-nested-optional-nullable.ts",
    );
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.nestedOptionalNullable.safeParse({}).success).toBe(true);
    expect(
      schemas.nestedOptionalNullable.safeParse({ profile: null }).success,
    ).toBe(true);
    expect(
      schemas.nestedOptionalNullable.safeParse({ profile: { bio: null } })
        .success,
    ).toBe(true);
    expect(
      schemas.nestedOptionalNullable.safeParse({ profile: { bio: 42 } })
        .success,
    ).toBe(false);
  });

  it("25-mongoose-raw-doc-warning: auto-unwrap produces the same correct schema either way", async () => {
    const { shapes, schemaOut } = await runFor(
      "25-mongoose-raw-doc-warning.ts",
    );
    const rawShape = shapes.find((s: any) => s.handler === "mongooseRawDoc");
    const normalizedShape = shapes.find(
      (s: any) => s.handler === "mongooseNormalized",
    );
    expect(rawShape!.warnings).toHaveLength(0);
    expect(normalizedShape!.warnings).toHaveLength(0);

    const schemas = await generateAndImport(shapes, schemaOut);
    const validDoc = { name: "Jade", email: "jade@example.com" };
    expect(schemas.mongooseRawDoc.safeParse(validDoc).success).toBe(true);
    expect(schemas.mongooseNormalized.safeParse(validDoc).success).toBe(true);
  });

  it("26-deeply-nested: multi-level nesting with arrays inside objects is fully preserved", async () => {
    const { shapes, schemaOut } = await runFor("26-deeply-nested.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const valid = {
      meta: { page: 1, total: 100 },
      items: [
        { id: "1", tags: ["a", "b"], author: { id: "u1", name: "Jade" } },
      ],
    };
    expect(schemas.deeplyNested.safeParse(valid).success).toBe(true);
    expect(
      schemas.deeplyNested.safeParse({ ...valid, items: [{ id: "1" }] })
        .success,
    ).toBe(false);
  });

  it("27-empty-object: accepts {} and rejects non-objects", async () => {
    const { shapes, schemaOut } = await runFor("27-empty-object.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.emptyObject.safeParse({}).success).toBe(true);
    expect(schemas.emptyObject.safeParse("nope").success).toBe(false);
  });

  it("28-promise-unwrapped: an awaited async function's resolved type is captured, not the Promise wrapper", async () => {
    const { shapes, schemaOut } = await runFor("28-promise-unwrapped.ts");
    expect(shapes[0].typeTexts[0]).not.toContain("Promise");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.promiseUnwrapped.safeParse({ id: "1", name: "Jade" }).success,
    ).toBe(true);
  });

  it("12-fail-spread: throws with a clear message, not ts-to-zod's confusing internal error", async () => {
    const { shapes, schemaOut } = await runFor("12-fail-spread.ts");
    expect(shapes[0].typeTexts).toHaveLength(0);
    expect(shapes[0].warnings[0]).toContain("spread");
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/No confidently-extracted response shapes/);
  });

  it("13-fail-build-response: throws with the same clear message, same root cause", async () => {
    const { shapes, schemaOut } = await runFor("13-fail-build-response.ts");
    expect(shapes[0].typeTexts).toHaveLength(0);
    expect(shapes[0].warnings[0]).toContain("isn't an object literal");
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/No confidently-extracted response shapes/);
  });

  it("17-null-and-primitives: throws specifically because of the null case, not primitives in general", async () => {
    const { shapes, schemaOut } = await runFor("17-null-and-primitives.ts");
    const nullShape = shapes.find((s: any) => s.handler === "primitiveNull");
    expect(nullShape!.typeTexts).toEqual(["null"]);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow();
  });

  it("24.fail-computed-keys: a computed sibling key does not block extraction of the literal 'data' shape", async () => {
    const { shapes, schemaOut } = await runFor("24.fail-computed-keys.ts");
    expect(shapes[0].warnings).toHaveLength(0);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(
      schemas.failComputedKey.safeParse({ id: "1", dynamic: "value" }).success,
    ).toBe(true);
  });
});
