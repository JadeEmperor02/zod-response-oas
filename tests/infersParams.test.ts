import { id } from "zod/locales";
import { inferParamsSchema } from "../src/index.js";
import { describe, it, expect } from "vitest";

describe("test the inferParamsSchema", () => {
  it("Infers Mongo ObjectId Validation for things paths having an id at the end irrespective of case", () => {
    const schema = inferParamsSchema("/users/:parentId", { id: "mongo" });

    expect(
      schema?.safeParse({
        parentId: "507f1f77bcf86cd799439011",
      }).success,
    ).toBe(true);

    expect(
      schema?.safeParse({
        parentId: "not-a-valid-id",
      }).success,
    ).toBe(false);
  });

  it("infers strings for non-id params", () => {
    const schema = inferParamsSchema("/users/:slug");

    expect(
      schema?.safeParse({
        slug: "jade",
      }).success,
    ).toBe(true);
  });
});
