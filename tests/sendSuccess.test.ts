import { describe, it, expect } from "vitest";
import { sendSuccess } from "./../src/response.js";

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

describe("sendSuccess", () => {
  it("defaults to 200 and includes ok/success/data with no message when none given", () => {
    const { res, calls } = fakeRes();
    sendSuccess(res, { data: { id: "1" } });

    expect(calls.statusCode).toBe(200);
    expect(calls.body).toEqual({ ok: true, success: true, data: { id: "1" } });
    expect(calls.body).not.toHaveProperty("message");
  });

  it("includes message only when provided", () => {
    const { res, calls } = fakeRes();
    sendSuccess(res, { data: { id: "1" }, message: "Created" });

    expect(calls.body).toEqual({
      ok: true,
      success: true,
      message: "Created",
      data: { id: "1" },
    });
  });

  it("spreads 'others' at the top level of the response body", () => {
    const { res, calls } = fakeRes();
    sendSuccess(res, { data: [1, 2, 3], others: { count: 3 } });

    expect(calls.body).toEqual({
      ok: true,
      success: true,
      data: [1, 2, 3],
      count: 3,
    });
  });

  it("respects an explicit statusCode", () => {
    const { res, calls } = fakeRes();
    sendSuccess(res, { data: { id: "1" }, statusCode: 201 });

    expect(calls.statusCode).toBe(201);
  });

  it("with zero options at all, still produces a valid envelope with data: undefined", () => {
    const { res, calls } = fakeRes();
    sendSuccess(res);

    expect(calls.statusCode).toBe(200);
    expect(calls.body.ok).toBe(true);
    expect(calls.body.success).toBe(true);
    expect(calls.body.data).toBeUndefined();
  });
});
