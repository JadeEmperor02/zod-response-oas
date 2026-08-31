import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

type Timestamped = { createdAt: string };
type Named = { name: string };

export function intersection(req: Request, res: Response) {
  const value: Timestamped & Named = { createdAt: "2026-01-01", name: "Jade" };

  return sendSuccess(res, {
    data: value,
  });
}
