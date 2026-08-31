import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

async function fetchUser(): Promise<{ id: string; name: string }> {
  return { id: "1", name: "Jade" };
}

export async function promiseUnwrapped(req: Request, res: Response) {
  const user = await fetchUser();
  return sendSuccess(res, {
    data: user,
  });
}
