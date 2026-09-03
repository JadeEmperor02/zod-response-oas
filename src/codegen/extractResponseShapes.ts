/**
 * Walks controller source via ts-morph and records each sendSuccess call as a
 * typed variant so mixed branches (data vs message-only) are not collapsed.
 *
 * Mongoose document types are normalized to plain serializable object shapes
 * before type text is emitted — ts-to-zod never sees FlattenMaps / Document /
 * HydratedDocument machinery.
 */

import {
  Project,
  SyntaxKind,
  Node,
  CallExpression,
  Type,
  SymbolFlags,
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

        if (!dataProp && othersTypeTexts.length === 0 && !hasMessage) {
          if (othersProp && othersTypeTexts.length === 0) {
            continue;
          }
          variants.push({ kind: "empty" });
          continue;
        }

        if (!dataProp) {
          variants.push({
            kind: "response",
            hasMessage,
            othersTypeTexts,
          });
          continue;
        }

        const dataTypeText = extractDataTypeText(
          dataProp,
          call.getStartLineNumber(),
          warnings,
        );
        if (dataTypeText === null) {
          continue;
        }

        variants.push({
          kind: "data",
          dataTypeText,
          hasMessage,
          othersTypeTexts,
        });
      }

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
      const propertyType = normalizeSerializableType(
        initializer.getType(),
        initializer,
      );
      fields.push(`${propertyName}: ${propertyType}`);
    } else if (Node.isShorthandPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      const propertyName = property.getName();
      const propertyType = normalizeSerializableType(
        nameNode.getType(),
        nameNode,
      );
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
 * Resolve the TypeScript type text of `data`, normalizing Mongoose document
 * types into plain serializable object shapes. Returns null only when the
 * call should be skipped (with a warning already recorded).
 */

function scrubLibraryTypeText(typeText: string): string {
  return (
    typeText
      // ObjectId — JSON is a string
      .replace(/import\("mongoose"\)\.Types\.ObjectId/g, "string")
      .replace(/mongoose\.Types\.ObjectId/g, "string")
      .replace(/\bTypes\.ObjectId\b/g, "string")
      .replace(/import\("bson"\)\.ObjectId/g, "string")
      // other common leaks
      .replace(/import\("mongoose"\)\.Types\.Decimal128/g, "string")
      .replace(/mongoose\.Types\.Decimal128/g, "string")
      .replace(/import\("mongoose"\)\.Types\.Buffer/g, "string")
      .replace(/mongoose\.Types\.Buffer/g, "string")
      // belt-and-suspenders: any leftover namespace ref
      .replace(/import\("mongoose"\)\.[A-Za-z0-9_.]+/g, "unknown")
      .replace(/mongoose\.[A-Za-z0-9_.]+/g, "unknown")
  );
}

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

  if (Node.isObjectLiteralExpression(dataInitializer)) {
    return extractObjectLiteralType(dataInitializer);
  }

  const dataType = dataInitializer.getType();

  const aliasSymbol = dataType.getAliasSymbol();
  const symbol = dataType.getSymbol();
  const aliasName = aliasSymbol?.getName();
  const symbolName = symbol?.getName();

  if (symbolName === "HydratedDocument" || aliasName === "HydratedDocument") {
    const typeArgs = dataType.getTypeArguments();
    const decls = (symbol ?? aliasSymbol)?.getDeclarations() ?? [];
    const isInterface = decls.some((d) => Node.isInterfaceDeclaration(d));
    const isFromMongoose = decls.some(isMongooseDeclaration);

    // interface → unwrap T, no warning
    if (typeArgs.length > 0 && (isInterface || isFromMongoose)) {
      return normalizeSerializableType(typeArgs[0], dataInitializer);
    }

    // type alias → warn, then normalize
    if (
      typeArgs.length > 0 &&
      aliasName === "HydratedDocument" &&
      !isInterface
    ) {
      warnings.push(
        `line ${line} — "data" looks like a raw Mongoose document (non-nominal HydratedDocument type alias); ...`,
      );
      return normalizeSerializableType(dataType, dataInitializer);
    }
  }

  // Expanded intersection with document methods, name already gone
  if (looksLikeLocalMongooseStandIn(dataType, dataInitializer)) {
    warnings.push(
      `line ${line} — "data" looks like a raw Mongoose document (methods/internal fields on the type); ...`,
    );
  }

  return normalizeSerializableType(dataType, dataInitializer);
}

// ---------------------------------------------------------------------------
// Mongoose / serializable-type normalization
// ---------------------------------------------------------------------------

function isExternalDeclaration(node: Node): boolean {
  const filePath = node.getSourceFile().getFilePath();
  return filePath.includes(`${path.sep}node_modules${path.sep}`);
}

function looksLikeLocalMongooseStandIn(type: Type, location: Node): boolean {
  const text = type.getText(location);
  if (text.includes("HydratedDocument") || text.includes("FlattenMaps")) {
    return true;
  }
  const methodNames = new Set(["save", "populate", "toObject", "toJSON"]);
  for (const prop of type.getProperties()) {
    if (!methodNames.has(prop.getName())) continue;
    try {
      if (prop.getTypeAtLocation(location).getCallSignatures().length > 0) {
        return type.getIntersectionTypes().length > 0;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}
/**
 * Heuristic detector only — used to decide when to run property-based
 * extraction. Stripping still keys off declaration origin, not this list.
 */
function looksLikeMongooseDocument(type: Type): boolean {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const name = symbol?.getName();

  // Nominal HydratedDocument / Document / FlattenMaps:
  // only trust the symbol when it actually comes from mongoose.
  if (
    symbol &&
    (name === "HydratedDocument" ||
      name === "Document" ||
      name === "FlattenMaps")
  ) {
    const declarations = symbol.getDeclarations();

    if (declarations.some(isMongooseDeclaration)) {
      return true;
    }
  }

  /*
   * Expanded Mongoose types often lose their nominal symbol and are printed
   * as intersections such as:
   *
   *   FlattenMaps<T> &
   *   Document<...> &
   *   Required<{ _id: ... }> &
   *   { __v: number }
   *
   * These are exactly the shapes we want to normalize.
   *
   * IMPORTANT: HydratedDocument is intentionally NOT included here.
   * A consumer can define a local type named HydratedDocument<T>, and
   * extractDataTypeText() explicitly rejects that case unless its symbol
   * belongs to mongoose.
   */
  const text = type.getText();

  if (
    text.includes("FlattenMaps") ||
    text.includes("mongoose.Document<") ||
    text.includes("Document<") ||
    text.includes("Require_id") ||
    text.includes("Default__v") ||
    text.includes("BufferToJSON")
  ) {
    return true;
  }

  // Expanded Mongoose intersections may have nested Mongoose constituents.
  const parts = type.getIntersectionTypes();

  if (
    parts.length > 1 &&
    parts.some((part) => looksLikeMongooseDocument(part))
  ) {
    return true;
  }

  return false;
}

/**
 * Prefer keeping a property when at least one declaration is from the
 * consumer project. Always keep `_id` / `__v` (serialized document fields)
 * even when declared only inside mongoose.
 */
function shouldKeepProperty(
  propertyName: string,
  declarations: Node[],
): boolean {
  if (propertyName === "_id" || propertyName === "__v") {
    return true;
  }
  if (declarations.length === 0) {
    // No declaration info — keep only if it doesn't look like an internal
    // Mongoose runtime key ($__, $isNew, methods often have no useful decls)
    return !propertyName.startsWith("$");
  }
  return declarations.some((d) => !isExternalDeclaration(d));
}

function isNominalMongooseType(type: Type, names: string[]): boolean {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();

  if (!symbol || !names.includes(symbol.getName())) {
    return false;
  }

  return (symbol.getDeclarations() ?? []).some(isMongooseDeclaration);
}

function isOptionalProperty(property: import("ts-morph").Symbol): boolean {
  // Optional if any declaration is a PropertySignature/PropertyDeclaration
  // with a question token, or the symbol has Optional flag.
  try {
    if (property.hasFlags?.(SymbolFlags.Optional)) {
      return true;
    }
  } catch {
    // older ts-morph — fall through
  }
  for (const decl of property.getDeclarations()) {
    if (
      Node.isPropertySignature(decl) ||
      Node.isPropertyDeclaration(decl) ||
      Node.isParameterDeclaration(decl)
    ) {
      if (decl.hasQuestionToken?.()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a plain `{ field: type; ... }` from a (possibly Mongoose) object type
 * by keeping project-owned properties (+ _id / __v).
 */
function normalizeMongooseDocument(type: Type, location: Node): string {
  // Nominal HydratedDocument<T> — prefer T when available
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const name = symbol?.getName();

  // lean() → FlattenMaps<T>; hydrated → HydratedDocument<T>
  if (name === "HydratedDocument" || name === "FlattenMaps") {
    const typeArgs = type.getTypeArguments();
    if (typeArgs.length > 0) {
      return normalizeSerializableType(typeArgs[0], location);
    }
  }

  const fields: string[] = [];
  const seen = new Set<string>();

  for (const property of type.getProperties()) {
    const name = property.getName();
    if (seen.has(name)) continue;

    // Skip obvious callable methods / symbols that are never JSON fields
    if (name === "constructor" || name.startsWith("$$")) continue;

    const declarations = property.getDeclarations();
    if (!shouldKeepProperty(name, declarations)) {
      continue;
    }

    // Methods: if every project declaration is a method, skip (not JSON)
    const projectDecls = declarations.filter((d) => !isExternalDeclaration(d));
    if (
      projectDecls.length > 0 &&
      projectDecls.every(
        (d) =>
          Node.isMethodSignature(d) ||
          Node.isMethodDeclaration(d) ||
          Node.isFunctionTypeNode(d),
      )
    ) {
      continue;
    }

    let propertyType: Type;
    try {
      propertyType = property.getTypeAtLocation(location);
    } catch {
      continue;
    }

    // Skip pure function types (Document methods that leaked through)
    if (
      propertyType.getCallSignatures().length > 0 &&
      !propertyType.isObject()
    ) {
      continue;
    }
    if (
      propertyType.getCallSignatures().length > 0 &&
      propertyType.getProperties().length === 0
    ) {
      continue;
    }

    const nested = normalizeSerializableType(propertyType, location);
    const optional = isOptionalProperty(property);
    fields.push(`${name}${optional ? "?" : ""}: ${nested}`);
    seen.add(name);
  }

  if (fields.length === 0) {
    // Fallback: cannot build a useful plain shape — emit original text so
    // generation fails loudly rather than inventing z.any().
    return scrubLibraryTypeText(type.getText(location));
  }

  return `{\n  ${fields.join(";\n  ")}\n}`;
}

function isMongooseDeclaration(node: Node): boolean {
  const filePath = node.getSourceFile().getFilePath();

  return filePath.includes(
    `${path.sep}node_modules${path.sep}mongoose${path.sep}`,
  );
}
/**
 * Recursively turn a TypeScript type into a serializable representation
 * suitable for ts-to-zod. Mongoose documents become plain object types;
 * arrays/unions recurse; everything else keeps getText().
 */
function normalizeSerializableType(type: Type, location: Node): string {
  // Avoid infinite recursion on pathological self-references
  return scrubLibraryTypeText(
    normalizeSerializableTypeInner(type, location, new Set()),
  );
}

function normalizeSerializableTypeInner(
  type: Type,
  location: Node,
  seen: Set<Type>,
): string {
  // Stack-based cycle guard: same Type may appear on independent sibling
  // properties and must still be normalized. Only bail when this type is
  // already on the *current* recursion path (a true cycle).
  if (seen.has(type)) {
    return type.getText(location);
  }

  seen.add(type);
  try {
    // Array / readonly array
    if (type.isArray()) {
      const element = type.getArrayElementType();

      if (element) {
        const elementText = normalizeSerializableTypeInner(
          element,
          location,
          seen,
        );

        const needsParens =
          element.getUnionTypes().length > 1 ||
          element.getIntersectionTypes().length > 1;

        return `${needsParens ? `(${elementText})` : elementText}[]`;
      }
    }

    // Tuple
    if (type.isTuple()) {
      const elements = type.getTupleElements();
      const parts = elements.map((el) =>
        normalizeSerializableTypeInner(el, location, seen),
      );
      return `[${parts.join(", ")}]`;
    }

    // Union — normalize each branch; strip `undefined` so optionals
    // become `foo?: T` instead of `foo?: T | undefined` → z.undefined()
    const unionParts = type.getUnionTypes();
    if (unionParts.length > 1) {
      const nonUndef = unionParts.filter((p) => !p.isUndefined());

      // Had undefined in the union — emit only the value side.
      // Optionality is already expressed via `name?:` on object properties.
      if (nonUndef.length < unionParts.length) {
        if (nonUndef.length === 0) {
          return "undefined"; // rare; avoid if you can
        }
        if (nonUndef.length === 1) {
          return nonUndef
            .map((p) => normalizeSerializableTypeInner(p, location, seen))
            .join("|");
        }
      }
      return unionParts
        .map((p) => normalizeSerializableTypeInner(p, location, seen))
        .join(" | ");
    }

    // Intersection — if Mongoose-shaped, collapse via property extraction;
    // otherwise join normalized constituents.
    const intersectionParts = type.getIntersectionTypes();
    if (intersectionParts.length > 1) {
      if (looksLikeMongooseDocument(type)) {
        return normalizeMongooseDocument(type, location);
      }
      return intersectionParts
        .map((p) => normalizeSerializableTypeInner(p, location, seen))
        .join(" & ");
    }

    if (looksLikeMongooseDocument(type)) {
      return normalizeMongooseDocument(type, location);
    }

    // Ordinary type — keep as-is (named aliases, primitives, object literals, …)
    return type.getText(location);
  } finally {
    seen.delete(type);
  }
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
        `${property.getName()}: ${normalizeSerializableType(property.getType(), property)}`,
      );
      continue;
    }

    if (Node.isShorthandPropertyAssignment(property)) {
      fields.push(
        `${property.getName()}: ${normalizeSerializableType(
          property.getNameNode().getType(),
          property.getNameNode(),
        )}`,
      );
    }
  }

  return `{ ${fields.join("; ")} }`;
}
