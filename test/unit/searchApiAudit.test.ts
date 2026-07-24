import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { H3Event } from "h3";

const h3Mocks = vi.hoisted(() => {
  const getQuery = vi.fn();
  const readBody = vi.fn();

  const createHttpError = (input: {
    statusCode: number;
    statusMessage: string;
  }): Error & { statusCode: number; statusMessage: string } => {
    const error = new Error(input.statusMessage) as Error & {
      statusCode: number;
      statusMessage: string;
    };
    error.statusCode = input.statusCode;
    error.statusMessage = input.statusMessage;
    return error;
  };

  return {
    getQuery,
    readBody,
    defineEventHandler: <T>(handler: T) => handler,
    createError: vi.fn(createHttpError),
    sendError: vi.fn((_event: unknown, error: unknown) => {
      throw error;
    }),
    createHttpError,
  };
});

const serviceMocks = vi.hoisted(() => ({
  getOrCreateSearchService: vi.fn(),
  getOrCreateSearchAuditService: vi.fn(),
}));

const requireAuthMocks = vi.hoisted(() => ({
  requireSearchAuth: vi.fn(),
}));

const requestMetaMocks = vi.hoisted(() => ({
  getRequestMeta: vi.fn(),
}));

vi.mock("h3", () => ({
  defineEventHandler: h3Mocks.defineEventHandler,
  getQuery: h3Mocks.getQuery,
  readBody: h3Mocks.readBody,
  createError: h3Mocks.createError,
  sendError: h3Mocks.sendError,
}));

vi.mock("../../server/utils/requireAuth", () => requireAuthMocks);
vi.mock("../../server/core/utils/requestMeta", () => requestMetaMocks);
vi.mock("../../server/core/services", () => serviceMocks);

import searchGetHandler from "../../server/api/search.get";
import searchPostHandler from "../../server/api/search.post";
import {
  getOrCreateSearchAuditService,
  getOrCreateSearchService,
} from "../../server/core/services";
import { loggers } from "../../server/core/utils/logger";

const useRuntimeConfigMock = vi.fn(() => ({}));
const getQueryMock = h3Mocks.getQuery;
const readBodyMock = h3Mocks.readBody;
const requireSearchAuthMock = requireAuthMocks.requireSearchAuth;
const getRequestMetaMock = requestMetaMocks.getRequestMeta;
const searchWithWarningsMock = vi.fn();
const recordMock = vi.fn();

function createEvent(
  method: string,
  path = "/api/search",
  waitUntil?: (promise: Promise<unknown>) => void
): H3Event {
  return {
    method,
    path,
    waitUntil,
    node: {
      req: {
        method,
        url: path,
        headers: {},
        socket: {},
      },
    },
  } as unknown as H3Event;
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe("search API audit routes", () => {
  beforeEach(() => {
    getQueryMock.mockReset();
    readBodyMock.mockReset();
    requireSearchAuthMock.mockReset();
    getRequestMetaMock.mockReset();
    searchWithWarningsMock.mockReset();
    recordMock.mockReset();
    vi.mocked(getOrCreateSearchService).mockReset();
    vi.mocked(getOrCreateSearchAuditService).mockReset();
    vi.stubGlobal("useRuntimeConfig", useRuntimeConfigMock);

    requireSearchAuthMock.mockImplementation(() => undefined);
    getRequestMetaMock.mockReturnValue({
      ip: "203.0.113.10",
      method: "GET",
      path: "/api/search",
      userAgent: "Vitest",
      requestId: "req-1",
    });

    vi.mocked(getOrCreateSearchService).mockReturnValue({
      searchWithWarnings: searchWithWarningsMock,
    } as any);
    vi.mocked(getOrCreateSearchAuditService).mockReturnValue({
      record: recordMock,
    } as any);

    searchWithWarningsMock.mockResolvedValue({
      response: {
        total: 2,
        merged_by_type: {
          quark: [],
        },
      },
      warnings: [],
    });
    recordMock.mockResolvedValue(undefined);
    getQueryMock.mockReturnValue({});
    readBodyMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes a success audit record for GET search", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    getQueryMock.mockReturnValue({
      kw: "  movie  ",
      channels: " tg-a, tg-b , ",
      conc: "3",
      refresh: "true",
      res: "merge",
      src: "all",
      plugins: " plugin-a ",
      cloud_types: " quark, aliyun ",
      ext: '{"sort":"desc"}',
    });

    const response = await searchGetHandler(createEvent("GET", "/api/search?kw=movie", waitUntilMock));

    expect(response).toEqual({
      code: 0,
      message: "success",
      data: {
        total: 2,
        merged_by_type: {
          quark: [],
        },
      },
    });
    expect(searchWithWarningsMock).toHaveBeenCalledWith(
      "movie",
      ["tg-a", "tg-b"],
      3,
      true,
      "merged_by_type",
      "all",
      ["plugin-a"],
      ["quark", "aliyun"],
      { sort: "desc" },
      undefined
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);

    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        meta: {
          ip: "203.0.113.10",
          method: "GET",
          path: "/api/search",
          userAgent: "Vitest",
          requestId: "req-1",
        },
        input: {
          keyword: "  movie  ",
          source: "all",
          channels: ["tg-a", "tg-b"],
          plugins: ["plugin-a"],
          cloudTypes: ["quark", "aliyun"],
          refresh: true,
        },
        outcome: {
          success: true,
          statusCode: 200,
          resultCount: 2,
        },
      })
    );
  });

  it("writes a success audit record for POST search", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    readBodyMock.mockResolvedValue({
      kw: "  movie  ",
      src: "plugin",
      res: "merge",
      plugins: " plugin-a , plugin-b ",
      cloud_types: ["quark", ""],
      refresh: true,
      ext: { sort: "desc" },
    });

    const response = await searchPostHandler(createEvent("POST", "/api/search", waitUntilMock));

    expect(response).toEqual({
      code: 0,
      message: "success",
      data: {
        total: 2,
        merged_by_type: {
          quark: [],
        },
      },
    });
    expect(searchWithWarningsMock).toHaveBeenCalledWith(
      "movie",
      undefined,
      undefined,
      true,
      "merged_by_type",
      "plugin",
      ["plugin-a", "plugin-b"],
      ["quark"],
      { sort: "desc" },
      undefined
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);

    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "  movie  ",
          source: "plugin",
          channels: undefined,
          plugins: ["plugin-a", "plugin-b"],
          cloudTypes: ["quark"],
          refresh: true,
        },
        outcome: {
          success: true,
          statusCode: 200,
          resultCount: 2,
        },
      })
    );
  });

  it("writes a 400 audit record when POST kw is missing", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    readBodyMock.mockResolvedValue({
      kw: "   ",
      src: "plugin",
      plugins: ["plugin-a"],
      cloud_types: ["quark"],
      refresh: true,
    });

    await expect(searchPostHandler(createEvent("POST", "/api/search", waitUntilMock))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "kw is required",
    });

    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "   ",
          source: "plugin",
          channels: undefined,
          plugins: ["plugin-a"],
          cloudTypes: ["quark"],
          refresh: true,
        },
        outcome: {
          success: false,
          statusCode: 400,
          errorMessage: "kw is required",
        },
      })
    );
  });

  it("writes a 401 audit record when POST auth fails before body parsing", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    requireSearchAuthMock.mockImplementation(() => {
      throw h3Mocks.createHttpError({ statusCode: 401, statusMessage: "search locked" });
    });

    await expect(searchPostHandler(createEvent("POST", "/api/search", waitUntilMock))).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: "search locked",
    });

    await Promise.allSettled(backgroundTasks);

    expect(readBodyMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "",
          source: "all",
          channels: undefined,
          plugins: undefined,
          cloudTypes: undefined,
          refresh: false,
        },
        outcome: {
          success: false,
          statusCode: 401,
          errorMessage: "search locked",
        },
      })
    );
  });

  it("writes a 400 audit record when GET ext json is invalid", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    getQueryMock.mockReturnValue({
      kw: "movie",
      ext: "{",
    });

    await expect(searchGetHandler(createEvent("GET", "/api/search", waitUntilMock))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining("invalid ext json:"),
    });

    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "movie",
          source: "all",
          channels: undefined,
          plugins: undefined,
          cloudTypes: undefined,
          refresh: false,
        },
        outcome: {
          success: false,
          statusCode: 400,
          errorMessage: expect.stringContaining("invalid ext json:"),
        },
      })
    );
  });

  it("writes a failure audit record when the search service throws", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    getQueryMock.mockReturnValue({
      kw: "movie",
      src: "tg",
      channels: " tg-a ",
    });
    searchWithWarningsMock.mockRejectedValue(new Error("search failed"));

    await expect(searchGetHandler(createEvent("GET", "/api/search", waitUntilMock))).rejects.toThrow("search failed");

    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "movie",
          source: "tg",
          channels: ["tg-a"],
          plugins: undefined,
          cloudTypes: undefined,
          refresh: false,
        },
        outcome: {
          success: false,
          statusCode: 500,
          errorMessage: "search failed",
        },
      })
    );
  });

  it("does not block POST response on slow audit writes", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });
    let resolveAudit: (() => void) | undefined;
    const auditPromise = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const settledMock = vi.fn();

    readBodyMock.mockResolvedValue({
      kw: "movie",
      src: "plugin",
      plugins: ["plugin-a"],
    });
    recordMock.mockImplementation(() => auditPromise);

    const response = await searchPostHandler(createEvent("POST", "/api/search", waitUntilMock));

    expect(response).toEqual({
      code: 0,
      message: "success",
      data: {
        total: 2,
        merged_by_type: {
          quark: [],
        },
      },
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(backgroundTasks).toHaveLength(1);

    backgroundTasks[0]?.then(() => {
      settledMock();
    });
    await flushMicrotasks();

    expect(settledMock).not.toHaveBeenCalled();

    resolveAudit?.();
    await Promise.allSettled(backgroundTasks);

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(settledMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the original success response when audit recording rejects", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    readBodyMock.mockResolvedValue({
      kw: "movie",
      src: "plugin",
      plugins: ["plugin-a"],
    });
    recordMock.mockRejectedValue(new Error("audit failed"));

    const response = await searchPostHandler(createEvent("POST", "/api/search", waitUntilMock));

    expect(response).toEqual({
      code: 0,
      message: "success",
      data: {
        total: 2,
        merged_by_type: {
          quark: [],
        },
      },
    });

    await Promise.allSettled(backgroundTasks);

    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when audit recording rejects", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });
    const warnSpy = vi.spyOn(loggers.api, "warn").mockImplementation(() => undefined);

    readBodyMock.mockResolvedValue({
      kw: "movie",
      src: "plugin",
      plugins: ["plugin-a"],
    });
    recordMock.mockRejectedValue(new Error("audit failed"));

    try {
      const response = await searchPostHandler(createEvent("POST", "/api/search", waitUntilMock));

      expect(response).toEqual({
        code: 0,
        message: "success",
        data: {
          total: 2,
          merged_by_type: {
            quark: [],
          },
        },
      });

      await Promise.allSettled(backgroundTasks);

      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Search audit recording failed",
        expect.objectContaining({
          error: "audit failed",
          requestId: "req-1",
          path: "/api/search",
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("writes a 401 audit record when GET auth fails", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });

    getQueryMock.mockReturnValue({
      kw: "movie",
      src: "tg",
      channels: "tg-a",
      plugins: "plugin-a",
      cloud_types: "quark",
      refresh: "true",
    });
    requireSearchAuthMock.mockImplementation(() => {
      throw h3Mocks.createHttpError({ statusCode: 401, statusMessage: "search locked" });
    });

    await expect(searchGetHandler(createEvent("GET", "/api/search?kw=movie", waitUntilMock))).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: "search locked",
    });

    await Promise.allSettled(backgroundTasks);

    expect(searchWithWarningsMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          keyword: "movie",
          source: "tg",
          channels: ["tg-a"],
          plugins: undefined,
          cloudTypes: ["quark"],
          refresh: true,
        },
        outcome: {
          success: false,
          statusCode: 401,
          errorMessage: "search locked",
        },
      })
    );
  });
});
