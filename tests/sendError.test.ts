import { describe, it, expect } from "vitest";
import { sendError } from "./../src/response.js";

function fakeRes() {
  const calls: { statusCode?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      calls.statusCode = code;
      return res;
    },
    json(body: any) {
      calls.body = body;
      return res;
    },
  };
  return { res, calls };
}

describe("sendError", () => {
  it("defaults to 400 with ok/success false and the given msg, no errors key when none given", () => {
    const { res, calls } = fakeRes();
    sendError(res, "Something went wrong");

    expect(calls.statusCode).toBe(400);
    expect(calls.body).toEqual({
      ok: false,
      success: false,
      msg: "Something went wrong",
    });
    expect(calls.body).not.toHaveProperty("errors");
  });

  it("includes errors only when provided", () => {
    const { res, calls } = fakeRes();
    const errors = { fieldErrors: { name: ["Required"] } };
    sendError(res, "Validation error", { errors });

    expect(calls.body).toEqual({
      ok: false,
      success: false,
      msg: "Validation error",
      errors,
    });
  });

  it("respects an explicit statusCode", () => {
    const { res, calls } = fakeRes();
    sendError(res, "Unauthorized", { statusCode: 401 });

    expect(calls.statusCode).toBe(401);
  });
});
