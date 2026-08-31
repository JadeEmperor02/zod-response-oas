/**
 * Controller corpus — extraction + generation, verified with real .safeParse.
 * Updated for variants-based extract and { schema, kind } generated map.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractResponseShapes } from "../src/codegen/extractResponseShapes.js";
import { generateZodSchemas } from "../src/codegen/generateZodSchemas.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import type {
  ExtractedShape,
  ResponseVariant,
} from "../src/codegen/extractResponseShapes.js";

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

type GeneratedEntry = {
  schema: { safeParse: (v: unknown) => { success: boolean } } | null;
  kind: "data" | "response";
};

function dataTypeTexts(shape: ExtractedShape): string[] {
  return shape.variants
    .filter(
      (v): v is Extract<ResponseVariant, { kind: "data" }> => v.kind === "data",
    )
    .map((v) => v.dataTypeText);
}

function schemaOf(
  map: Record<string, GeneratedEntry>,
  handler: string,
): NonNullable<GeneratedEntry["schema"]> {
  const entry = map[handler];
  expect(entry, `missing generated entry for ${handler}`).toBeDefined();
  expect(entry.schema, `schema is null for ${handler}`).not.toBeNull();
  return entry.schema!;
}

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

async function generateAndImport(
  shapes: ExtractedShape[],
  schemaOut: string,
): Promise<Record<string, GeneratedEntry>> {
  generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot });
  const mod = await import(schemaOut + `?t=${Date.now()}`);
  return mod.responseSchemas as Record<string, GeneratedEntry>;
}

describe("Controller corpus — extraction + generation, verified against real .safeParse behavior", () => {
  it("01-simple: plain object shape validates correctly", async () => {
    const { shapes, schemaOut } = await runFor("01-simple.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.simple.kind).toBe("data");
    const s = schemaOf(schemas, "simple");
    expect(s.safeParse({ id: "123", name: "Jade" }).success).toBe(true);
    expect(s.safeParse({ id: "123" }).success).toBe(false);
  });

  it("02-nested: nested object structure is preserved, not flattened", async () => {
    const { shapes, schemaOut } = await runFor("02-nested.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "nested");
    expect(
      s.safeParse({
        user: { id: "1", profile: { name: "Jade", age: 30 } },
      }).success,
    ).toBe(true);
    expect(s.safeParse({ user: { id: "1" } }).success).toBe(false);
  });

  it("03-list-array: array of objects, each element validated", async () => {
    const { shapes, schemaOut } = await runFor("03-list-array.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "list");
    expect(s.safeParse([{ id: "1", name: "A" }]).success).toBe(true);
    expect(s.safeParse([{ id: "1" }]).success).toBe(false);
    expect(s.safeParse({ id: "1", name: "A" }).success).toBe(false);
  });

  it("04-mapped: only the PROJECTED shape from .map() is captured", async () => {
    const { shapes, schemaOut } = await runFor("04-mapped.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "mapped");
    expect(s.safeParse([{ id: "1", name: "A" }]).success).toBe(true);
    expect(s.safeParse([{ id: "1" }]).success).toBe(false);
  });

  it("05-typed-interface: named interface throws clearly — not silent", async () => {
    const { shapes, schemaOut } = await runFor("05-typed-interface.ts");
    expect(dataTypeTexts(shapes[0])).toEqual(["UserResponse"]);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema|failed schema generation/i);
  });

  it("07-unions: named union alias is expanded to a self-contained union", async () => {
    const { shapes, schemaOut } = await runFor("07-unions.ts");

    const texts = dataTypeTexts(shapes[0]);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/type: "user"/);
    expect(texts[0]).toMatch(/type: "error"/);

    const schemas = await generateAndImport(shapes, schemaOut);

    const s = schemaOf(schemas, "unions");

    expect(
      s.safeParse({
        type: "user",
        userId: "abc",
      }).success,
    ).toBe(true);

    expect(
      s.safeParse({
        type: "error",
        reason: "boom",
      }).success,
    ).toBe(true);
  });

  it("19-array-of-unions: named union alias is expanded and preserved inside the array", async () => {
    const { shapes, schemaOut } = await runFor("19-array-of-unions.ts");

    const texts = dataTypeTexts(shapes[0]);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('kind: "a"');
    expect(texts[0]).toContain('kind: "b"');
    expect(texts[0]).toMatch(/^\(.+\)\[\]$/);

    const schemas = await generateAndImport(shapes, schemaOut);

    const s = schemaOf(schemas, "arrayOfUnions");

    expect(
      s.safeParse([
        { kind: "a", a: 1 },
        { kind: "b", b: "hello" },
      ]).success,
    ).toBe(true);

    expect(s.safeParse([{ kind: "a", b: "wrong" }]).success).toBe(false);
  });

  it("22-intersection: intersection of named aliases hits the same limitation", async () => {
    const { shapes, schemaOut } = await runFor("22-intersection.ts");
    const texts = dataTypeTexts(shapes[0]);
    expect(texts.length).toBe(1);
    expect(texts[0]).toMatch(/Timestamped|Named|&/);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/silently produced no schema|failed schema generation/i);
  });

  it("06-optional-properties: an optional field is genuinely optional", async () => {
    const { shapes, schemaOut } = await runFor("06-optional-properties.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "optionalProps");
    expect(s.safeParse({ id: "1" }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
  });

  it("08-ternary: both branches captured as a union with literal types intact", async () => {
    const { shapes, schemaOut } = await runFor("08-ternary.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "ternary");
    expect(
      s.safeParse({
        role: "admin",
        permissions: ["read", "write"],
      }).success,
    ).toBe(true);
    expect(s.safeParse({ role: "superadmin", permissions: [] }).success).toBe(
      false,
    );
  });

  it("09-multiple-calls: two data branches both validate through the same union schema", async () => {
    const { shapes, schemaOut } = await runFor("09-multiple-calls.ts");
    expect(dataTypeTexts(shapes[0])).toHaveLength(2);
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.multipleCalls.kind).toBe("data");
    const s = schemaOf(schemas, "multipleCalls");
    expect(s.safeParse({ status: "pending" }).success).toBe(true);
    expect(s.safeParse({ status: "complete", result: "done" }).success).toBe(
      true,
    );
  });

  it("10-no-data: message-only becomes kind response envelope (not empty data / z.any)", async () => {
    const { shapes, schemaOut } = await runFor("10-no-data.ts");
    expect(shapes[0].variants).toHaveLength(1);
    expect(shapes[0].variants[0].kind).toBe("response");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.noData.kind).toBe("response");
    const s = schemaOf(schemas, "noData");
    // Full envelope: success + ok + message (required when message key present)
    expect(
      s.safeParse({
        success: true,
        ok: true,
        message: "ok",
      }).success,
    ).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse("not an object").success).toBe(false);
  });

  it("11-failed-computed-variable: opaque unknown-typed value produces z.unknown()", async () => {
    const { shapes, schemaOut } = await runFor(
      "11-failed-computed-variable.ts",
    );
    expect(dataTypeTexts(shapes[0])).toEqual(["unknown"]);
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "failComputedVariable");
    expect(s.safeParse({ anything: true }).success).toBe(true);
  });

  it("14-fail-generic: explicit type argument resolves concretely", async () => {
    const { shapes, schemaOut } = await runFor("14-fail-generic.ts");
    const texts = dataTypeTexts(shapes[0]);
    expect(texts[0]).toMatch(/id.*string/);
    expect(texts[0]).toMatch(/value.*number/);
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "failGeneric");
    expect(s.safeParse({ id: "1", value: 42 }).success).toBe(true);
    expect(s.safeParse({ id: "1", value: "42" }).success).toBe(false);
  });

  it("15-const-arrow: arrow assigned to const is found under the variable name", async () => {
    const { shapes, schemaOut } = await runFor("15-const-arrow.ts");
    expect(shapes[0].handler).toBe("constArrow");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "constArrow");
    expect(s.safeParse({ mode: "arrow", ok: true }).success).toBe(true);
    expect(s.safeParse({ mode: "arrow", ok: false }).success).toBe(false);
  });

  it("16-message-and-others: only data is the kind:data payload schema", async () => {
    const { shapes, schemaOut } = await runFor("16-message-and-others.ts");
    expect(dataTypeTexts(shapes[0])[0]).toMatch(/count/);
    expect(shapes[0].variants[0].kind).toBe("data");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.messageAndOthers.kind).toBe("data");
    const s = schemaOf(schemas, "messageAndOthers");
    expect(s.safeParse({ count: 42 }).success).toBe(true);
    expect(s.safeParse({ requestId: "abc-123" }).success).toBe(false);
  });

  it("18-as-const-literal: literals preserved as narrow types, not widened", async () => {
    const { shapes, schemaOut } = await runFor("18-as-const-literal.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "asConstLiteral");
    expect(s.safeParse({ status: "ok", code: 200 }).success).toBe(true);
    expect(s.safeParse({ status: "pending", code: 200 }).success).toBe(false);
  });

  it("20-record-index-signature: Record<string, number> enforces the value type", async () => {
    const { shapes, schemaOut } = await runFor("20-record-index-signature.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "recordIndex");
    expect(s.safeParse({ alice: 10, bob: 20 }).success).toBe(true);
    expect(s.safeParse({ alice: "10" }).success).toBe(false);
  });

  it("23-nested-optional-nullable: optional AND nullable both behave correctly", async () => {
    const { shapes, schemaOut } = await runFor(
      "23-nested-optional-nullable.ts",
    );
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "nestedOptionalNullable");
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ profile: null }).success).toBe(true);
    expect(s.safeParse({ profile: { bio: null } }).success).toBe(true);
    expect(s.safeParse({ profile: { bio: 42 } }).success).toBe(false);
  });

  it("25-mongoose-raw-doc-warning: auto-unwrap produces a usable schema", async () => {
    const { shapes, schemaOut } = await runFor(
      "25-mongoose-raw-doc-warning.ts",
    );
    const rawShape = shapes.find((s) => s.handler === "mongooseRawDoc");
    const normalizedShape = shapes.find(
      (s) => s.handler === "mongooseNormalized",
    );
    expect(rawShape!.warnings).toHaveLength(0);
    expect(normalizedShape!.warnings).toHaveLength(0);

    const schemas = await generateAndImport(shapes, schemaOut);
    const validDoc = { name: "Jade", email: "jade@example.com" };
    expect(
      schemaOf(schemas, "mongooseRawDoc").safeParse(validDoc).success,
    ).toBe(true);
    expect(
      schemaOf(schemas, "mongooseNormalized").safeParse(validDoc).success,
    ).toBe(true);
  });

  it("26-deeply-nested: multi-level nesting with arrays is preserved", async () => {
    const { shapes, schemaOut } = await runFor("26-deeply-nested.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "deeplyNested");
    const valid = {
      meta: { page: 1, total: 100 },
      items: [
        { id: "1", tags: ["a", "b"], author: { id: "u1", name: "Jade" } },
      ],
    };
    expect(s.safeParse(valid).success).toBe(true);
    expect(s.safeParse({ ...valid, items: [{ id: "1" }] }).success).toBe(false);
  });

  it("27-empty-object: accepts {} and rejects non-objects", async () => {
    const { shapes, schemaOut } = await runFor("27-empty-object.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "emptyObject");
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse("nope").success).toBe(false);
  });

  it("29-empty-success: call with no data results in kind: response", async () => {
    const { shapes, schemaOut } = await runFor("29-empty-success.ts");
    const schemas = await generateAndImport(shapes, schemaOut);
    expect(schemas.emptySuccess.schema).toBeNull();
    expect(schemas.emptySuccess.kind).toBe("response");
  });

  it("28-promise-unwrapped: awaited resolved type, not Promise wrapper", async () => {
    const { shapes, schemaOut } = await runFor("28-promise-unwrapped.ts");
    expect(dataTypeTexts(shapes[0])[0]).not.toContain("Promise");
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "promiseUnwrapped");
    expect(s.safeParse({ id: "1", name: "Jade" }).success).toBe(true);
  });

  it("12-fail-spread: variants empty + warning; generate fails that handler loudly", async () => {
    const { shapes, schemaOut } = await runFor("12-fail-spread.ts");
    expect(shapes[0].variants).toHaveLength(0);
    expect(shapes[0].warnings[0]).toContain("spread");
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/failed schema generation|no extractable|spread/i);
  });

  it("13-fail-build-response: variants empty + non-literal warning; generate fails loudly", async () => {
    const { shapes, schemaOut } = await runFor("13-fail-build-response.ts");
    expect(shapes[0].variants).toHaveLength(0);
    expect(shapes[0].warnings[0]).toMatch(/object literal/i);
    expect(() =>
      generateZodSchemas(shapes, { outputPath: schemaOut, projectRoot }),
    ).toThrow(/failed schema generation|no extractable|object literal/i);
  });

  it("17-null-and-primitives: null case fails generation; other primitives are separate handlers", async () => {
    const { shapes, schemaOut } = await runFor("17-null-and-primitives.ts");
    const nullShape = shapes.find((s) => s.handler === "primitiveNull");
    expect(dataTypeTexts(nullShape!)).toEqual(["null"]);
    // May throw on null only, or on the whole multi-handler file depending on
    // partition behavior — either way must not succeed silently for null.
    expect(() =>
      generateZodSchemas(
        shapes.filter((s) => s.handler === "primitiveNull"),
        { outputPath: schemaOut, projectRoot },
      ),
    ).toThrow();
  });

  it("24.fail-computed-keys: computed sibling does not block literal data shape", async () => {
    const { shapes, schemaOut } = await runFor("24.fail-computed-keys.ts");
    expect(shapes[0].warnings).toHaveLength(0);
    const schemas = await generateAndImport(shapes, schemaOut);
    const s = schemaOf(schemas, "failComputedKey");
    // Generated schema is for the known literal keys (id); dynamic key may
    // appear as index signature or be omitted — assert the confident part.
    expect(s.safeParse({ id: "1" }).success).toBe(true);
  });
});
