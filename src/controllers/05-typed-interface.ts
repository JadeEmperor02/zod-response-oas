/**
 * CORPUS: explicit interface annotation on the value passed to data
 * EXPECT: extract UserResponse → { id: string; name: string; age: number }
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

interface UserResponse {
  id: string;
  name: string;
  age: number;
}

function getUser(): UserResponse {
  return { id: "1", name: "Jade", age: 30 };
}

export function typed(req: Request, res: Response) {
  const user: UserResponse = getUser();

  return sendSuccess(res, {
    data: user,
  });
}
