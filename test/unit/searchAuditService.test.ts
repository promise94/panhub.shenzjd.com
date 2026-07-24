import { describe, expect, it } from "vitest";
import type {
  SearchAuditRecord,
  SearchAuditStore,
} from "../../server/core/services/searchAuditStore";
import {
  DEFAULT_SEARCH_AUDIT_RETENTION_DAYS,
  MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH,
  MAX_SEARCH_AUDIT_USER_AGENT_LENGTH,
  SearchAuditService,
} from "../../server/core/services/searchAuditService";

const DAY_MS = 24 * 60 * 60 * 1000;

class InMemorySearchAuditStore implements SearchAuditStore {
  public records: SearchAuditRecord[] = [];

  async insert(record: SearchAuditRecord): Promise<void> {
    this.records.push(record);
  }
}

describe("SearchAuditService", () => {
  it("builds and persists a normalized success audit record with default retention", async () => {
    const store = new InMemorySearchAuditStore();
    const service = new SearchAuditService({ store });
    const startedAt = new Date("2026-06-03T01:02:03.000Z");
    const finishedAt = new Date("2026-06-03T01:02:04.250Z");

    const originalStartedAt = startedAt.getTime();
    const originalFinishedAt = finishedAt.getTime();
    const expectedExpiresAt = new Date(
      originalStartedAt + DEFAULT_SEARCH_AUDIT_RETENTION_DAYS * DAY_MS
    );

    const record = await service.record({
      startedAt,
      finishedAt,
      meta: {
        ip: "1.2.3.4",
        method: "GET",
        path: "/api/search",
        userAgent: "Mozilla/5.0",
        requestId: "req-1",
      },
      input: {
        keyword: "  流浪   地球  ",
        source: "all",
        channels: [" tg-a ", "", "tg-b"],
        plugins: undefined,
        cloudTypes: [" quark ", "aliyun", " "],
        refresh: true,
      },
      outcome: {
        success: true,
        statusCode: 200,
        resultCount: 12,
        errorMessage: "should be cleared for success",
      },
    });
    const persistedRecord = store.records[0];

    startedAt.setUTCFullYear(2030);
    finishedAt.setUTCFullYear(2030);

    expect(store.records).toHaveLength(1);
    expect(persistedRecord).toMatchObject({
      ip: "1.2.3.4",
      keyword: "  流浪   地球  ",
      normalizedKeyword: "流浪 地球",
      method: "GET",
      path: "/api/search",
      source: "all",
      channels: ["tg-a", "tg-b"],
      plugins: [],
      cloudTypes: ["quark", "aliyun"],
      userAgent: "Mozilla/5.0",
      requestId: "req-1",
      success: true,
      statusCode: 200,
      durationMs: 1250,
      resultCount: 12,
      refresh: true,
      errorMessage: null,
      dayBucket: "2026-06-03",
    });
    expect(record).toMatchObject({
      ip: "1.2.3.4",
      keyword: "  流浪   地球  ",
      normalizedKeyword: "流浪 地球",
      method: "GET",
      path: "/api/search",
      source: "all",
      channels: ["tg-a", "tg-b"],
      plugins: [],
      cloudTypes: ["quark", "aliyun"],
      userAgent: "Mozilla/5.0",
      requestId: "req-1",
      success: true,
      statusCode: 200,
      durationMs: 1250,
      resultCount: 12,
      refresh: true,
      errorMessage: null,
      dayBucket: "2026-06-03",
    });
    expect(record.searchedAt.getTime()).toBe(originalStartedAt);
    expect(record.createdAt.getTime()).toBe(originalFinishedAt);
    expect(record.expiresAt).toEqual(expectedExpiresAt);
    expect(persistedRecord.searchedAt.getTime()).toBe(originalStartedAt);
    expect(persistedRecord.createdAt.getTime()).toBe(originalFinishedAt);
    expect(persistedRecord.expiresAt).toEqual(expectedExpiresAt);
  });

  it("uses custom retention and truncates long failure fields", async () => {
    const store = new InMemorySearchAuditStore();
    const service = new SearchAuditService({ store, retentionDays: 7 });
    const startedAt = new Date("2026-06-03T23:59:59.000Z");
    const finishedAt = new Date("2026-06-04T00:00:01.500Z");
    const userAgent = "u".repeat(MAX_SEARCH_AUDIT_USER_AGENT_LENGTH + 10);
    const errorMessage = "e".repeat(MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH + 20);

    const record = await service.record({
      startedAt,
      finishedAt,
      meta: {
        ip: "5.6.7.8",
        method: "POST",
        path: "/api/search",
        userAgent,
        requestId: undefined,
      },
      input: {
        keyword: "error",
        source: "plugin",
        channels: null,
        plugins: [" plugin-a ", " "],
        cloudTypes: undefined,
        refresh: false,
      },
      outcome: {
        success: false,
        statusCode: 500,
        resultCount: null,
        errorMessage,
      },
    });

    expect(store.records).toHaveLength(1);
    expect(record.success).toBe(false);
    expect(record.statusCode).toBe(500);
    expect(record.durationMs).toBe(2500);
    expect(record.dayBucket).toBe("2026-06-03");
    expect(record.channels).toEqual([]);
    expect(record.plugins).toEqual(["plugin-a"]);
    expect(record.cloudTypes).toEqual([]);
    expect(record.requestId).toBeNull();
    expect(record.resultCount).toBeNull();
    expect(record.userAgent).toBe(userAgent.slice(0, MAX_SEARCH_AUDIT_USER_AGENT_LENGTH));
    expect(record.userAgent).toHaveLength(MAX_SEARCH_AUDIT_USER_AGENT_LENGTH);
    expect(record.errorMessage).toBe(
      errorMessage.slice(0, MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH)
    );
    expect(record.errorMessage).toHaveLength(MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH);
    expect(record.expiresAt).toEqual(new Date(startedAt.getTime() + 7 * DAY_MS));
  });

  it("preserves resultCount when it is zero", async () => {
    const store = new InMemorySearchAuditStore();
    const service = new SearchAuditService({ store });

    const record = await service.record({
      startedAt: new Date("2026-06-03T08:00:00.000Z"),
      finishedAt: new Date("2026-06-03T08:00:01.000Z"),
      meta: {
        ip: "9.9.9.9",
        method: "GET",
        path: "/api/search",
        userAgent: null,
        requestId: null,
      },
      input: {
        keyword: "no result",
        source: "tg",
        channels: [],
        plugins: undefined,
        cloudTypes: [],
        refresh: false,
      },
      outcome: {
        success: true,
        statusCode: 200,
        resultCount: 0,
      },
    });

    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.source).toBe("tg");
    expect(store.records[0]?.resultCount).toBe(0);
    expect(record.resultCount).toBe(0);
  });
});
