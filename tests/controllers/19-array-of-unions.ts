/**
 * CORPUS: array of union members
 * EXPECT: Array<{ kind: "a"; a: number } | { kind: "b"; b: string }>
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

type Item = { kind: "a"; a: number } | { kind: "b"; b: string };

export function arrayOfUnions(req: Request, res: Response) {
  const items: Item[] = [
    { kind: "a", a: 1 },
    { kind: "b", b: "x" },
  ];

  return sendSuccess(res, {
    data: items,
  });
}
