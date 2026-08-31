import { Project, SyntaxKind, Node, CallExpression } from "ts-morph";
import path from "node:path";
import { writeFileSync } from "node:fs";

export interface ExtractResponseShapesOptions {
  tsconfigPath: string;
  controllerGlobs: string | string[];
  successHelperName?: string;
  outputPath: string;
  normalizeMethodNames?: string[];
}

/** One sendSuccess call site, classified by what it actually sends. */
export type ResponseVariant =
  | {
      kind: "data";
      dataTypeText: string;
      hasMessage: boolean;
      othersTypeTexts: string[];
    }
  | {
      kind: "response";
      hasMessage: boolean;
      othersTypeTexts: string[];
    }
  | {
      kind: "empty";
    };

export interface ExtractedShape {
  handler: string;
  file: string;
  variants: ResponseVariant[];
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

      const variants: ResponseVariant[] = [];
      const warnings: string[] = [];

      for (const call of calls) {
        const rawArg = call.getArguments()[1];
        if (!rawArg) {
          warnings.push(
            `call at line ${call.getStartLineNumber()} — missing second argument, can't extract response shape`,
          );
          continue;
        }

        const optionsArg = unwrapToExpression(rawArg);

        if (!Node.isObjectLiteralExpression(optionsArg)) {
          warnings.push(
            `call at line ${call.getStartLineNumber()} — second argument isn't an object literal, can't extract response shape`,
          );
          continue;
        }

        const hasSpread = optionsArg
          .getProperties()
          .some((p) => Node.isSpreadAssignment(p));
        if (hasSpread) {
          warnings.push(
            `call at line ${call.getStartLineNumber()} — options object contains a spread, can't confidently determine the response shape`,
          );
          continue;
        }

        const dataProp = optionsArg.getProperty("data");
        const othersProp = optionsArg.getProperty("others");
        const messageProp = optionsArg.getProperty("message");
        const hasMessage = Boolean(messageProp);

        const othersTypeTexts = extractOthersFields(
          othersProp,
          call.getStartLineNumber(),
          warnings,
        );

        // No data / others / message → confirmed empty success
        if (!dataProp && othersTypeTexts.length === 0 && !hasMessage) {
          // othersProp present but unparseable → already warned; don't mark empty
          if (othersProp && othersTypeTexts.length === 0) {
            continue;
          }
          variants.push({ kind: "empty" });
          continue;
        }

        // Message and/or others, no data → response-level variant
        if (!dataProp) {
          variants.push({
            kind: "response",
            hasMessage,
            othersTypeTexts,
          });
          continue;
        }

        // Data present → data variant (may also carry message/others on the same call)
        const dataTypeText = extractDataTypeText(
          dataProp,
          call.getStartLineNumber(),
          warnings,
        );
        if (dataTypeText === null) {
          // warned / skipped (e.g. raw mongoose.Document)
          continue;
        }

        variants.push({
          kind: "data",
          dataTypeText,
          hasMessage,
          othersTypeTexts,
        });
      }

      // Always record the handler if we saw sendSuccess — including empty /
      // message-only — so generate can emit { schema: null } or response kinds.
      if (variants.length > 0 || warnings.length > 0) {
        results.push({
          handler: name,
          file: path.relative(process.cwd(), sourceFile.getFilePath()),
          variants,
          warnings,
        });
      }
    }
  }

  writeFileSync(options.outputPath, JSON.stringify(results, null, 2));
  return results;
}

/** Unwrap `as const` / satisfies / parentheses so the object literal is visible. */
function unwrapToExpression(node: Node): Node {
  let cur = node;
  while (
    Node.isAsExpression(cur) ||
    Node.isSatisfiesExpression(cur) ||
    Node.isParenthesizedExpression(cur) ||
    Node.isTypeAssertion(cur)
  ) {
    cur = cur.getExpression();
  }
  return cur;
}

/**
 * Pull `others: { a: 1, b: "x" }` into property lines for envelope synthesis:
 * ["a: number", "b: string"]
 */
function extractOthersFields(
  othersProp: Node | undefined,
  line: number,
  warnings: string[],
): string[] {
  if (!othersProp) return [];

  if (!Node.isPropertyAssignment(othersProp)) {
    warnings.push(
      `call at line ${line} — "others" is not a plain object assignment, can't confidently extract its fields`,
    );
    return [];
  }

  const othersInitializer = othersProp.getInitializer();
  if (
    !othersInitializer ||
    !Node.isObjectLiteralExpression(othersInitializer)
  ) {
    warnings.push(
      `call at line ${line} — "others" isn't an object literal, can't confidently infer its fields`,
    );
    return [];
  }

  const fields: string[] = [];

  for (const property of othersInitializer.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();
      if (!initializer) continue;
      const propertyName = property.getName();
      const propertyType = initializer.getType().getText(initializer);
      fields.push(`${propertyName}: ${propertyType}`);
    } else if (Node.isShorthandPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      const propertyName = property.getName();
      const propertyType = nameNode.getType().getText(nameNode);
      fields.push(`${propertyName}: ${propertyType}`);
    } else if (Node.isSpreadAssignment(property)) {
      warnings.push(
        `call at line ${line} — "others" contains a spread, can't confidently infer all fields`,
      );
    } else {
      warnings.push(
        `call at line ${line} — "others" contains a property that can't be confidently inferred`,
      );
    }
  }

  return fields;
}

/**
 * Resolve the TypeScript type text of `data`, or null if this call should be
 * skipped (with a warning already recorded).
 */
function extractDataTypeText(
  dataProp: Node,
  line: number,
  warnings: string[],
): string | null {
  let dataInitializer: Node;

  if (Node.isPropertyAssignment(dataProp)) {
    const initializer = dataProp.getInitializer();
    if (!initializer) {
      warnings.push(`call at line ${line} — "data" has no initializer`);
      return null;
    }
    dataInitializer = initializer;
  } else if (Node.isShorthandPropertyAssignment(dataProp)) {
    dataInitializer = dataProp.getNameNode();
  } else {
    warnings.push(
      `call at line ${line} — "data" is not a plain value (method or accessor?), can't extract its shape`,
    );
    return null;
  }

  // Object literals can contain computed keys whose runtime names cannot
  // be resolved confidently. Preserve the known literal properties and
  // ignore the computed ones rather than allowing TypeScript to widen the
  // entire shape into an index signature.
  if (Node.isObjectLiteralExpression(dataInitializer)) {
    return extractObjectLiteralType(dataInitializer);
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
      `line ${line} — "data" looks like a raw Mongoose document (no .toObject()/.toJSON()); generated schema may leak internal fields`,
    );
  } else if (typeText.includes("mongoose.Document<")) {
    warnings.push(
      `line ${line} — "data" is a raw Mongoose document (not normalized via .toObject()/.lean()); ` +
        `its expanded type includes internal Document fields/methods that can't be confidently converted. ` +
        `Call .toObject() or .lean() on the query before sendSuccess, or pass "response:" explicitly for this route.`,
    );
    return null;
  }

  return typeText;
}

function extractObjectLiteralType(object: Node): string {
  if (!Node.isObjectLiteralExpression(object)) {
    throw new Error("Expected object literal");
  }

  const fields: string[] = [];

  for (const property of object.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      const name = property.getNameNode();

      // Computed key: [key]
      if (Node.isComputedPropertyName(name)) {
        continue;
      }

      const initializer = property.getInitializer();
      if (!initializer) continue;

      fields.push(
        `${property.getName()}: ${property.getType().getText(property)}`,
      );
      continue;
    }

    if (Node.isShorthandPropertyAssignment(property)) {
      fields.push(
        `${property.getName()}: ${property
          .getNameNode()
          .getType()
          .getText(property.getNameNode())}`,
      );
    }
  }

  return `{ ${fields.join("; ")} }`;
}
