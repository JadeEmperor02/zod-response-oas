import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

type WithId = { id: string };
type WithName = { name: string };

export function intersection(req: Request, res: Response) {
  const user: WithId & WithName = { id: "1", name: "Jade" };

  return sendSuccess(res, {
    data: user,
  });
}
