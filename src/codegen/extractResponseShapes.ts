import {
  Project,
  SyntaxKind,
  Node,
  CallExpression,
  SourceFile,
} from "ts-morph";
import path from "node:path";
import { writeFileSync } from "node:fs";

export interface ExtractResponseShapesOptions {
  tsconfigPath: string;
  controllerGlobs: string | string[];
  successHelperName?: string;
  outputPath: string;
  normalizeMethodNames?: string[];
}

export interface ExtractedShape {
  handler: string;
  file: string;
  typeTexts: string[];
  warnings: string[];
}

export function extractResponseShapes(
  options: ExtractResponseShapesOptions,
): ExtractedShape[] {
  const successHelperName = options.successHelperName ?? "sendSuccess";

  const project = new Project({ tsConfigFilePath: options.tsconfigPath });
  const globs = Array.isArray(options.controllerGlobs)
    ? options.controllerGlobs
    : [options.controllerGlobs];
  const controllerFiles = project.getSourceFiles(globs);

  const results: ExtractedShape[] = [];

  for (const sourceFile of controllerFiles) {
    const namedFns: { name: string; node: Node }[] = [];

    for (const decl of sourceFile.getFunctions()) {
      const name = decl.getName();
      if (name) namedFns.push({ name, node: decl });
    }

    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const arrow = varDecl.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (arrow) namedFns.push({ name: varDecl.getName(), node: arrow });
    }

    for (const { name, node: fn } of namedFns) {
      if (name === successHelperName) continue;

      const calls = fn
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter(
          (c: CallExpression) =>
            c.getExpression().getText() === successHelperName,
        );

      if (calls.length === 0) continue;

      const typeTexts = new Set<string>();
      const warnings: string[] = [];

      for (const call of calls) {
        const optionsArg = call.getArguments()[1];
        if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) {
          warnings.push(
            `call at line ${call.getStartLineNumber()} — second argument isn't an object literal, can't extract "data" shape`,
          );
          continue;
        }

        const dataProp = optionsArg.getProperty("data");

        const hasSpread = optionsArg
          .getProperties()
          .some((p) => Node.isSpreadAssignment(p));
        if (hasSpread) {
          warnings.push(
            `call at line ${call.getStartLineNumber()} — options object contains a spread, can't confidently determine the "data" shape`,
          );
          continue;
        }

        if (!dataProp) {
          // No "data" key at all — genuinely no payload.
          typeTexts.add("undefined");
          continue;
        }

        let dataInitializer: Node;
        if (Node.isPropertyAssignment(dataProp)) {
          dataInitializer = dataProp.getInitializer()!;
        } else if (Node.isShorthandPropertyAssignment(dataProp)) {
          // `{ data }` — shorthand for `{ data: data }`. A DIFFERENT AST
          // node kind (ShorthandPropertyAssignment, not PropertyAssignment)
          // that the original isPropertyAssignment-only check silently
          // missed, falling into the "no data" branch above and reporting
          // "undefined" for a call that unambiguously has a payload — a
          // confidently WRONG answer, not merely an uncertain one. The
          // referenced identifier's own type is exactly the "data" shape.
          dataInitializer = dataProp.getNameNode();
        } else {
          // A getter/method/other property kind we don't confidently
          // understand — report it rather than silently skipping.
          warnings.push(
            `call at line ${call.getStartLineNumber()} — "data" is not a plain value (method or accessor?), can't extract its shape`,
          );
          continue;
        }

        const dataType = dataInitializer.getType();
        let typeText = dataType.getText(dataInitializer);

        const symbol = dataType.getSymbol();
        const typeName = symbol?.getName();
        if (typeName === "HydratedDocument") {
          const typeArgs = dataType.getTypeArguments();
          if (typeArgs.length > 0) {
            typeText = typeArgs[0].getText(dataInitializer);
          }
        } else if (typeText.includes("HydratedDocument")) {
          warnings.push(
            `line ${call.getStartLineNumber()} — "data" looks like a raw Mongoose document (no .toObject()/.toJSON()); generated schema may leak internal fields`,
          );
        } else if (typeText.includes("mongoose.Document<")) {
          // Real Mongoose query results at a call site are usually NOT the
          // nominal `HydratedDocument<T>` interface reference the checks
          // above expect — they're the fully expanded structural form
          // TypeScript prints for it: an intersection like
          // `mongoose.Document<...> & IProperty & Required<{_id}> & {__v}`.
          // There's no single clean "T" to unwrap to here (unlike a real
          // HydratedDocument<T> reference), and handing this ~100-property
          // monster — full of internal methods, $locals, ObjectId, etc. —
          // to ts-to-zod produces a wall of "not supported" warnings and,
          // on at least some environments, a hard crash in its own
          // validation step. Refusing to guess and naming the fix (call
          // .toObject()/.lean() before sendSuccess) is far more useful
          // than either a crash or a mostly-z.any() schema would be.
          warnings.push(
            `line ${call.getStartLineNumber()} — "data" is a raw Mongoose document (not normalized via .toObject()/.lean()); ` +
              `its expanded type includes internal Document fields/methods that can't be confidently converted. ` +
              `Call .toObject() or .lean() on the query before sendSuccess, or pass "response:" explicitly for this route.`,
          );
          continue;
        }

        typeTexts.add(typeText);
      }

      if (typeTexts.size > 0 || warnings.length > 0) {
        results.push({
          handler: name,
          file: path.relative(process.cwd(), sourceFile.getFilePath()),
          typeTexts: Array.from(typeTexts),
          warnings,
        });
      }
    }
  }

  writeFileSync(options.outputPath, JSON.stringify(results, null, 2));
  return results;
}
