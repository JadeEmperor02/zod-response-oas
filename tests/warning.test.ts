import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractResponseShapes,
  type ExtractedShape,
  type ResponseVariant,
} from "../src/codegen/extractResponseShapes.js";
// Adjust import path to match your package layout.

const SEND_SUCCESS_STUB = `
function sendSuccess(res: any, options: any = {}) {
  return res.json(options);
}
`;

function extract(controllerSource: string): ExtractedShape[] {
  const dir = mkdtempSync(
    path.join(tmpdir(), "zod-response-oas-codegen-test-"),
  );
  writeFileSync(path.join(dir, "controller.ts"), controllerSource);
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["*.ts"],
    }),
  );
  const shapes = extractResponseShapes({
    tsconfigPath: path.join(dir, "tsconfig.json"),
    controllerGlobs: path.join(dir, "*.ts"),
    outputPath: path.join(dir, "shapes.json"),
  });
  rmSync(dir, { recursive: true, force: true });
  return shapes;
}

function dataTypeTexts(shape: ExtractedShape): string[] {
  return shape.variants
    .filter(
      (v): v is Extract<ResponseVariant, { kind: "data" }> => v.kind === "data",
    )
    .map((v) => v.dataTypeText);
}

describe("extraction: uncertainty produces a warning, never a guess", () => {
  it("a non-object second argument to sendSuccess is warned about, not silently accepted", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function getUser(req: any, res: any) {
  const options = { data: { id: "1" } };
  return sendSuccess(res, options); // NOT an inline object literal
}
`);
    expect(shapes).toHaveLength(1);
    // Nothing confidently extracted — no variants, only a warning
    expect(shapes[0].variants).toHaveLength(0);
    expect(
      shapes[0].warnings.some((w) => w.includes("isn't an object literal")),
    ).toBe(true);
  });

  it("a spread in the options object is warned about, not treated as 'no payload'", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function getUser(req: any, res: any) {
  const payload = { data: { id: "1" } };
  return sendSuccess(res, { ...payload }); // "data" could be hiding inside the spread
}
`);
    expect(shapes).toHaveLength(1);
    // Must NOT be guessed as empty/response — spread could supply data
    expect(shapes[0].variants).toHaveLength(0);
    expect(shapes[0].warnings.some((w) => w.includes("spread"))).toBe(true);
  });

  it("a computed property alongside a literal 'data' key does NOT block extraction of 'data'", () => {
    const key = "dynamicKey";
    const shapes = extract(`
${SEND_SUCCESS_STUB}
const someKey = "${key}";
export function getUser(req: any, res: any) {
  const user = { id: "1", name: "Jade" };
  return sendSuccess(res, { data: user, [someKey]: "value" });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    const texts = dataTypeTexts(shapes[0]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("id");
    expect(texts[0]).toContain("name");
  });

  it("a message-only success (no data) is a response variant, not a warning", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function deleteUser(req: any, res: any) {
  return sendSuccess(res, { message: "deleted" });
}
`);

    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    expect(shapes[0].variants).toHaveLength(1);
    expect(shapes[0].variants[0]).toMatchObject({
      kind: "response",
      hasMessage: true,
      othersTypeTexts: [],
    });
    // Old contract used typeTexts: ["undefined"] — that is gone; message-only
    // is first-class response, not a synthetic undefined data payload.
  });

  it("a genuinely empty success (no data/message/others) is an empty variant", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function ack(req: any, res: any) {
  return sendSuccess(res, { statusCode: 200 });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    expect(shapes[0].variants).toEqual([{ kind: "empty" }]);
  });

  it("a raw Mongoose-like document (type alias intersection) passed as data is warned about", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
type HydratedDocument<T> = T & { _id: string; save(): Promise<void> };
export function getUser(req: any, res: any) {
  const user = {} as HydratedDocument<{ name: string }>;
  return sendSuccess(res, { data: user });
}
`);
    expect(shapes).toHaveLength(1);
    // May still produce a data variant with a warning, or skip with warning only
    expect(
      shapes[0].warnings.some(
        (w) => w.includes("HydratedDocument") || w.includes("Mongoose"),
      ),
    ).toBe(true);
  });

  it("the same Mongoose-like type does NOT warn once .toObject() is used first", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
type HydratedDocument<T> = T & { _id: string; save(): Promise<void>; toObject(): T };
export function getUser(req: any, res: any) {
  const user = { toObject: () => ({ name: "Jade" }) } as HydratedDocument<{ name: string }>;
  return sendSuccess(res, { data: user.toObject() });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    const texts = dataTypeTexts(shapes[0]);
    expect(texts.length).toBeGreaterThan(0);
  });

  it("a NOMINAL interface HydratedDocument<T> is auto-unwrapped to T with NO warning", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
interface HydratedDocument<T> { _id: string; toObject(): T; }
type UserDoc = HydratedDocument<{ name: string; email: string }>;
declare function findUser(): UserDoc;
export function getUser(req: any, res: any) {
  return sendSuccess(res, { data: findUser() }); // no .toObject() call at all
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    const texts = dataTypeTexts(shapes[0]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("name");
    expect(texts[0]).toContain("email");
    expect(texts[0]).not.toContain("_id");
  });

  it("a non-nominal HydratedDocument-shaped type is NOT auto-unwrapped and still warns", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
type HydratedDocument<T> = T & { _id: string; save(): Promise<void> };
export function getUser(req: any, res: any) {
  const user = {} as HydratedDocument<{ name: string }>;
  return sendSuccess(res, { data: user });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings.length).toBeGreaterThan(0);
  });

  it("mixed data + message-only branches produce both variant kinds", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function getOrEmpty(req: any, res: any) {
  if (req.query.empty) {
    return sendSuccess(res, { message: "Nothing found" });
  }
  return sendSuccess(res, { data: { id: "1" } });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    const kinds = shapes[0].variants.map((v) => v.kind).sort();
    expect(kinds).toEqual(["data", "response"]);
  });
});
