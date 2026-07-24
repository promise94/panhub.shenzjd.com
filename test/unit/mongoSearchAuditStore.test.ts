import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchAuditRecord } from "../../server/core/services/searchAuditStore";
import { DEFAULT_SEARCH_AUDIT_RETENTION_DAYS } from "../../server/core/services/searchAuditService";
import {
  createMongoSearchAuditStore,
  getOrCreateSearchAuditService,
  resetSearchAuditRuntime,
} from "../../server/core/services";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_AUDIT_INDEXES = [
  { key: { ip: 1, searchedAt: -1 } },
  { key: { normalizedKeyword: 1, searchedAt: -1 } },
  { key: { searchedAt: -1 } },
  { key: { ip: 1, normalizedKeyword: 1, searchedAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
];

const sharedState = vi.hoisted(() => {
  const findChain = {
    sort: vi.fn(() => findChain),
    skip: vi.fn(() => findChain),
    limit: vi.fn(() => findChain),
    toArray: vi.fn(),
  };
  const aggregateCursor = { toArray: vi.fn() };
  return {
    connect: vi.fn(),
    db: vi.fn(),
    collection: vi.fn(),
    createIndexes: vi.fn(),
    insertOne: vi.fn(),
    find: vi.fn(() => findChain),
    findChain,
    countDocuments: vi.fn(),
    aggregate: vi.fn(() => aggregateCursor),
    aggregateCursor,
    constructors: [] as Array<{ url: string; options: Record<string, unknown> }>,
  };
});

vi.mock("mongodb", () => {
  class MongoClient {
    constructor(url: string, options: Record<string, unknown> = {}) {
      sharedState.constructors.push({ url, options });
    }

    async connect() {
      return sharedState.connect();
    }

    db(name: string) {
      sharedState.db(name);
      return {
        collection(collectionName: string) {
          sharedState.collection(collectionName);
          return {
            createIndexes: sharedState.createIndexes,
            insertOne: sharedState.insertOne,
            find: sharedState.find,
            countDocuments: sharedState.countDocuments,
            aggregate: sharedState.aggregate,
          };
        },
      };
    }
  }

  return { MongoClient };
});

describe("mongoSearchAuditStore", () => {
  beforeEach(() => {
    resetSearchAuditRuntime();
    sharedState.connect.mockReset();
    sharedState.db.mockReset();
    sharedState.collection.mockReset();
    sharedState.createIndexes.mockReset();
    sharedState.insertOne.mockReset();
    sharedState.find.mockClear();
    sharedState.findChain.sort.mockClear();
    sharedState.findChain.skip.mockClear();
    sharedState.findChain.limit.mockClear();
    sharedState.findChain.toArray.mockReset();
    sharedState.countDocuments.mockReset();
    sharedState.aggregate.mockClear();
    sharedState.aggregateCursor.toArray.mockReset();
    sharedState.constructors.length = 0;
  });

  it("creates one shared MongoClient, initializes indexes, and inserts records", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-1" });

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    const record = createRecord();

    await store.insert(record);
    await store.insert(record);

    expect(sharedState.constructors).toHaveLength(1);
    expect(sharedState.constructors[0]).toEqual({
      url: "mongodb://localhost:27017",
      options: expect.objectContaining({
        serverSelectionTimeoutMS: 1000,
      }),
    });
    expect(sharedState.connect).toHaveBeenCalledTimes(1);
    expect(sharedState.db).toHaveBeenCalledWith("panhub");
    expect(sharedState.collection).toHaveBeenCalledWith("search_audit_logs");
    expect(sharedState.createIndexes).toHaveBeenCalledTimes(1);
    expect(sharedState.createIndexes).toHaveBeenCalledWith(SEARCH_AUDIT_INDEXES, {
      timeoutMS: 1000,
    });
    expect(sharedState.insertOne).toHaveBeenCalledTimes(2);
    expect(sharedState.insertOne).toHaveBeenNthCalledWith(1, record, {
      timeoutMS: 1000,
    });
  });

  it("shares cold-start initialization across concurrent inserts", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-concurrent" });

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    await Promise.all([store.insert(createRecord()), store.insert(createRecord())]);

    expect(sharedState.constructors).toHaveLength(1);
    expect(sharedState.connect).toHaveBeenCalledTimes(1);
    expect(sharedState.createIndexes).toHaveBeenCalledTimes(1);
    expect(sharedState.insertOne).toHaveBeenCalledTimes(2);
  });

  it("does not self-timeout writes with an outer promise wrapper", async () => {
    vi.useFakeTimers();

    try {
      sharedState.connect.mockResolvedValue(undefined);
      sharedState.createIndexes.mockResolvedValue(undefined);

      let resolveInsert:
        | ((value: { acknowledged: boolean; insertedId: string }) => void)
        | undefined;

      sharedState.insertOne.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInsert = resolve as (value: { acknowledged: boolean; insertedId: string }) => void;
          })
      );

      const store = createMongoSearchAuditStore({
        mongoUrl: "mongodb://localhost:27017",
        dbName: "panhub",
        collectionName: "search_audit_logs",
        writeTimeoutMs: 10,
      });

      let settled = false;
      const insertPromise = store.insert(createRecord()).finally(() => {
        settled = true;
      });

      await vi.waitFor(() => {
        expect(sharedState.insertOne).toHaveBeenCalledWith(createRecord(), {
          timeoutMS: 10,
        });
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(false);

      resolveInsert?.({ acknowledged: true, insertedId: "id-timeout" });
      await expect(insertPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies timeoutMS to index creation during initialization", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-index-timeout" });

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 25,
    });

    await expect(store.insert(createRecord())).resolves.toBeUndefined();

    expect(sharedState.createIndexes).toHaveBeenCalledWith(SEARCH_AUDIT_INDEXES, {
      timeoutMS: 25,
    });
  });

  it("configures connect timeout bounds on the MongoClient", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-connect-timeout" });

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 15,
    });

    await expect(store.insert(createRecord())).resolves.toBeUndefined();

    expect(sharedState.constructors[0]).toEqual({
      url: "mongodb://localhost:27017",
      options: expect.objectContaining({
        connectTimeoutMS: 15,
        serverSelectionTimeoutMS: 15,
      }),
    });
  });

  it("allows later retries when initialization fails", async () => {
    sharedState.connect
      .mockRejectedValueOnce(new Error("connect failed"))
      .mockResolvedValueOnce(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-2" });

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    await expect(store.insert(createRecord())).rejects.toThrow("connect failed");
    await expect(store.insert(createRecord())).resolves.toBeUndefined();

    expect(sharedState.connect).toHaveBeenCalledTimes(2);
    expect(sharedState.createIndexes).toHaveBeenCalledTimes(1);
    expect(sharedState.insertOne).toHaveBeenCalledTimes(1);
  });

  it("returns null service and warns when mongo url or db config is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const service = getOrCreateSearchAuditService({
      searchAuditMongoUrl: "",
      searchAuditMongoDb: "panhub",
      searchAuditMongoCollection: "search_audit_logs",
      searchAuditRetentionDays: 360,
      searchAuditWriteTimeoutMs: 1000,
    });

    expect(service).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("uses the default collection when the runtime config omits it", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-default" });

    const service = getOrCreateSearchAuditService({
      searchAuditMongoUrl: "mongodb://localhost:27017",
      searchAuditMongoDb: "panhub",
      searchAuditRetentionDays: 7,
      searchAuditWriteTimeoutMs: 1000,
    });

    expect(service).not.toBeNull();

    await service?.record({
      startedAt: new Date("2026-06-03T00:00:00.000Z"),
      finishedAt: new Date("2026-06-03T00:00:01.000Z"),
      meta: {
        ip: "203.0.113.10",
        method: "GET",
        path: "/api/search",
        userAgent: "Mozilla/5.0",
        requestId: "req-default-collection",
      },
      input: {
        keyword: "流浪地球",
        source: "all",
        refresh: false,
      },
      outcome: {
        success: true,
        statusCode: 200,
        resultCount: 1,
      },
    });

    expect(sharedState.collection).toHaveBeenCalledWith("search_audit_logs");
    expect(sharedState.constructors[0]).toEqual({
      url: "mongodb://localhost:27017",
      options: expect.objectContaining({
        serverSelectionTimeoutMS: 1000,
      }),
    });
  });

  it("falls back to the default retention when the runtime config value is invalid", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-retention" });

    const startedAt = new Date("2026-06-03T00:00:00.000Z");
    const service = getOrCreateSearchAuditService({
      searchAuditMongoUrl: "mongodb://localhost:27017",
      searchAuditMongoDb: "panhub",
      searchAuditMongoCollection: "search_audit_logs",
      searchAuditRetentionDays: Number.NaN,
      searchAuditWriteTimeoutMs: 1000,
    });

    expect(service).not.toBeNull();

    await service?.record({
      startedAt,
      finishedAt: new Date("2026-06-03T00:00:01.000Z"),
      meta: {
        ip: "203.0.113.10",
        method: "GET",
        path: "/api/search",
        userAgent: "Mozilla/5.0",
        requestId: "req-invalid-retention",
      },
      input: {
        keyword: "流浪地球",
        source: "all",
        refresh: false,
      },
      outcome: {
        success: true,
        statusCode: 200,
        resultCount: 1,
      },
    });

    expect(sharedState.insertOne).toHaveBeenCalledTimes(1);
    expect(sharedState.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date(
          startedAt.getTime() + DEFAULT_SEARCH_AUDIT_RETENTION_DAYS * DAY_MS
        ),
      }),
      {
        timeoutMS: 1000,
      }
    );
  });

  it("falls back to the default write timeout when the runtime config value is invalid", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-timeout-default" });

    const service = getOrCreateSearchAuditService({
      searchAuditMongoUrl: "mongodb://localhost:27017",
      searchAuditMongoDb: "panhub",
      searchAuditMongoCollection: "search_audit_logs",
      searchAuditRetentionDays: 7,
      searchAuditWriteTimeoutMs: Number.POSITIVE_INFINITY,
    });

    expect(service).not.toBeNull();

    await service?.record({
      startedAt: new Date("2026-06-03T00:00:00.000Z"),
      finishedAt: new Date("2026-06-03T00:00:01.000Z"),
      meta: {
        ip: "203.0.113.10",
        method: "GET",
        path: "/api/search",
        userAgent: "Mozilla/5.0",
        requestId: "req-invalid-timeout",
      },
      input: {
        keyword: "流浪地球",
        source: "all",
        refresh: false,
      },
      outcome: {
        success: true,
        statusCode: 200,
        resultCount: 1,
      },
    });

    expect(sharedState.constructors[0]).toEqual({
      url: "mongodb://localhost:27017",
      options: expect.objectContaining({
        connectTimeoutMS: 1000,
        serverSelectionTimeoutMS: 1000,
      }),
    });
    expect(sharedState.insertOne).toHaveBeenCalledWith(expect.any(Object), {
      timeoutMS: 1000,
    });
  });

  it("caches the created search audit service and resets it for tests", () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.insertOne.mockResolvedValue({ acknowledged: true, insertedId: "id-3" });

    const runtimeConfig = {
      searchAuditMongoUrl: "mongodb://localhost:27017",
      searchAuditMongoDb: "panhub",
      searchAuditMongoCollection: "search_audit_logs",
      searchAuditRetentionDays: 7,
      searchAuditWriteTimeoutMs: 1000,
    };

    const first = getOrCreateSearchAuditService(runtimeConfig);
    const second = getOrCreateSearchAuditService(runtimeConfig);

    expect(first).not.toBeNull();
    expect(second).toBe(first);

    resetSearchAuditRuntime();

    const third = getOrCreateSearchAuditService(runtimeConfig);

    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
  });

  it("find returns paginated results sorted by searchedAt desc", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    const record = createRecord();
    sharedState.findChain.toArray.mockResolvedValue([record]);
    sharedState.countDocuments.mockResolvedValue(1);

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    const result = await store.find({ ip: "203.0.113.10" }, { page: 1, pageSize: 50 });

    expect(result).toEqual({ items: [record], total: 1, page: 1, pageSize: 50 });
    expect(sharedState.find).toHaveBeenCalledWith(
      { ip: "203.0.113.10" },
      { maxTimeMS: 1000 }
    );
    expect(sharedState.findChain.sort).toHaveBeenCalledWith({ searchedAt: -1 });
    expect(sharedState.findChain.skip).toHaveBeenCalledWith(0);
    expect(sharedState.findChain.limit).toHaveBeenCalledWith(50);
    expect(sharedState.countDocuments).toHaveBeenCalledWith(
      { ip: "203.0.113.10" },
      { maxTimeMS: 1000 }
    );
  });

  it("find builds keyword, status, and time range filters and clamps paging", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.findChain.toArray.mockResolvedValue([]);
    sharedState.countDocuments.mockResolvedValue(0);

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-31T00:00:00.000Z");

    await store.find(
      { keyword: "  流浪 地球 ", method: "GET", statusCode: 200, success: true, from, to },
      { page: 2, pageSize: 500 }
    );

    expect(sharedState.find).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedKeyword: { $regex: "流浪 地球", $options: "i" },
        method: "GET",
        statusCode: 200,
        success: true,
        searchedAt: { $gte: from, $lte: to },
      }),
      { maxTimeMS: 1000 }
    );
    expect(sharedState.findChain.skip).toHaveBeenCalledWith(200);
    expect(sharedState.findChain.limit).toHaveBeenCalledWith(200);
  });

  it("stats aggregates total, success, byMethod, byStatusCode, and daily", async () => {
    sharedState.connect.mockResolvedValue(undefined);
    sharedState.createIndexes.mockResolvedValue(undefined);
    sharedState.countDocuments.mockResolvedValueOnce(10).mockResolvedValueOnce(8);
    sharedState.aggregateCursor.toArray.mockResolvedValue([
      { _id: "GET", count: 9 },
      { _id: "POST", count: 1 },
    ]);

    const store = createMongoSearchAuditStore({
      mongoUrl: "mongodb://localhost:27017",
      dbName: "panhub",
      collectionName: "search_audit_logs",
      writeTimeoutMs: 1000,
    });

    const stats = await store.stats();

    expect(stats.total).toBe(10);
    expect(stats.successCount).toBe(8);
    expect(stats.failureCount).toBe(2);
    expect(stats.byMethod).toEqual([
      { _id: "GET", count: 9 },
      { _id: "POST", count: 1 },
    ]);
    expect(sharedState.countDocuments).toHaveBeenCalledTimes(2);
    expect(sharedState.aggregate).toHaveBeenCalledTimes(3);
  });
});

function createRecord(): SearchAuditRecord {
  return {
    searchedAt: new Date("2026-06-03T00:00:00.000Z"),
    createdAt: new Date("2026-06-03T00:00:01.000Z"),
    expiresAt: new Date("2027-05-29T00:00:00.000Z"),
    dayBucket: "2026-06-03",
    ip: "203.0.113.10",
    keyword: "流浪地球",
    normalizedKeyword: "流浪地球",
    method: "GET",
    path: "/api/search",
    source: "all",
    channels: [],
    plugins: [],
    cloudTypes: [],
    userAgent: "Mozilla/5.0",
    requestId: "req-1",
    success: true,
    statusCode: 200,
    durationMs: 1000,
    resultCount: 10,
    refresh: false,
    errorMessage: null,
  };
}
