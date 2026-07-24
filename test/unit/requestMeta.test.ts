import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRequestMeta } from "../../server/core/utils/requestMeta";

function createEvent(options: {
  headers?: Record<string, string | undefined>;
  method?: string;
  path?: string;
  remoteAddress?: string;
} = {}): H3Event {
  const method = options.method ?? "GET";
  const path = options.path ?? "/api/search";

  return {
    method,
    path,
    node: {
      req: {
        method,
        url: path,
        headers: options.headers ?? {},
        socket: {
          remoteAddress: options.remoteAddress,
        },
      },
    },
  } as unknown as H3Event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRequestMeta", () => {
  it("prefers forwarded headers only behind a private or local proxy and strips the IPv4 mapped prefix", () => {
    const meta = getRequestMeta(
      createEvent({
        method: "POST",
        path: "/api/search",
        remoteAddress: "::ffff:10.0.0.1",
        headers: {
          "x-forwarded-for": " ::ffff:203.0.113.10, 198.51.100.1 ",
          "user-agent": "Mozilla/5.0",
          "x-request-id": "req-primary",
          "request-id": "req-fallback",
        },
      })
    );

    expect(meta).toEqual({
      ip: "203.0.113.10",
      method: "POST",
      path: "/api/search",
      userAgent: "Mozilla/5.0",
      requestId: "req-primary",
    });
  });

  it("falls back to request-id when x-request-id is missing", () => {
    const meta = getRequestMeta(
      createEvent({
        headers: {
          "x-real-ip": "::ffff:10.0.0.8",
          "request-id": "req-fallback-only",
        },
        remoteAddress: "::ffff:10.0.0.1",
      })
    );

    expect(meta.ip).toBe("10.0.0.8");
    expect(meta.userAgent).toBeNull();
    expect(meta.requestId).toBe("req-fallback-only");
  });

  it("falls back to crypto.randomUUID when request id headers are missing", () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("generated-req-id");

    const meta = getRequestMeta(
      createEvent({
        path: "/api/search?kw=test",
        remoteAddress: "::ffff:127.0.0.1",
      })
    );

    expect(meta).toMatchObject({
      ip: "127.0.0.1",
      method: "GET",
      path: "/api/search",
      requestId: "generated-req-id",
    });
    expect(randomUuidSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores forwarded headers from a public direct peer", () => {
    const meta = getRequestMeta(
      createEvent({
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "x-real-ip": "203.0.113.11",
        },
        remoteAddress: "198.51.100.5",
      })
    );

    expect(meta.ip).toBe("198.51.100.5");
  });

  it("does not trust forwarded headers when remote address is unavailable", () => {
    const meta = getRequestMeta(
      createEvent({
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "x-real-ip": "203.0.113.11",
        },
      })
    );

    expect(meta.ip).toBe("unknown");
  });
});
