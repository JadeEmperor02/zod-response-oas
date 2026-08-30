/**
 * CORPUS: deeper nesting + arrays inside objects
 * EXPECT: full nested structure preserved
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function deeplyNested(req: Request, res: Response) {
  return sendSuccess(res, {
    data: {
      meta: {
        page: 1,
        total: 100,
      },
      items: [
        {
          id: "1",
          tags: ["a", "b"],
          author: {
            id: "u1",
            name: "Jade",
          },
        },
      ],
    },
  });
}
