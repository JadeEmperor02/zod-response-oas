import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractResponseShapes } from "../src/codegen/extractResponseShapes.js";

const SEND_SUCCESS_STUB = `
function sendSuccess(res: any, options: any = {}) {
  return res.json(options);
}
`;

function extract(controllerSource: string) {
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
    expect(shapes[0].typeTexts).toHaveLength(0); // nothing confidently extracted
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
    // Must NOT have been guessed as "undefined" (no payload) — that would be
    // wrong if the spread actually supplies a "data" key, which it does here.
    expect(shapes[0].typeTexts).not.toContain("undefined");
    expect(shapes[0].typeTexts).toHaveLength(0);
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
    expect(shapes[0].warnings).toHaveLength(0); // the computed sibling key doesn't affect "data" extraction
    expect(shapes[0].typeTexts[0]).toContain("id");
    expect(shapes[0].typeTexts[0]).toContain("name");
  });

  it("a genuinely absent data field (real 'no payload' case, no spread involved) is NOT warned about", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
export function deleteUser(req: any, res: any) {
  return sendSuccess(res, { message: "deleted" });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings).toHaveLength(0);
    expect(shapes[0].typeTexts).toEqual(["undefined"]);
  });

  it("a raw Mongoose-like document passed directly as data is warned about", () => {
    const shapes = extract(`
${SEND_SUCCESS_STUB}
type HydratedDocument<T> = T & { _id: string; save(): Promise<void> };
export function getUser(req: any, res: any) {
  const user = {} as HydratedDocument<{ name: string }>;
  return sendSuccess(res, { data: user });
}
`);
    expect(shapes).toHaveLength(1);
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
  });

  it("a NOMINAL interface HydratedDocument<T> (matching real Mongoose's actual declaration shape) is auto-unwrapped to T with NO warning", () => {
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
    expect(shapes[0].warnings).toHaveLength(0); // auto-unwrapped, not flagged
    expect(shapes[0].typeTexts[0]).toContain("name");
    expect(shapes[0].typeTexts[0]).toContain("email");
    expect(shapes[0].typeTexts[0]).not.toContain("_id"); // proves T was extracted, not the wrapper
  });

  it("a non-nominal HydratedDocument-shaped type (a type alias/intersection, not a real interface) is NOT auto-unwrapped and still warns", () => {
    // This is the precise boundary of the auto-unwrap: it keys off the
    // TYPE'S OWN SYMBOL being a declared interface named HydratedDocument
    // (which is how @types/mongoose actually declares it) — not a textual
    // match on the name. A `type X = T & {...}` intersection alias has no
    // such symbol, even if a human would call it "Mongoose-shaped."
    const shapes = extract(`
${SEND_SUCCESS_STUB}
type HydratedDocument<T> = T & { _id: string; save(): Promise<void> };
export function getUser(req: any, res: any) {
  const user = {} as HydratedDocument<{ name: string }>;
  return sendSuccess(res, { data: user });
}
`);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].warnings.length).toBeGreaterThan(0); // correctly falls back to warning, not a guess
  });
});
