/**
 * CORPUS: .map() producing a projected shape
 * EXPECT: extract { id: string; name: string }[]  (or Array<{ id: string; name: string }>)
 * SHOULD: succeed if ts-morph can follow the map callback return type
 * RISK: may degrade depending on getUsers() return type
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

function getUsers(): Array<{
  id: string;
  name: string;
  email: string;
  secret: string;
}> {
  return [];
}

export function mapped(req: Request, res: Response) {
  const users = getUsers();

  return sendSuccess(res, {
    data: users.map((user) => ({
      id: user.id,
      name: user.name,
    })),
  });
}
