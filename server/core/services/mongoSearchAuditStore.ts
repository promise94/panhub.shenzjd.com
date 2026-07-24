import type { Collection, MongoClient as MongoClientType } from "mongodb";
import type {
  SearchAuditQuery,
  SearchAuditQueryOptions,
  SearchAuditQueryResult,
  SearchAuditRecord,
  SearchAuditStatsBucket,
  SearchAuditStatsResult,
  SearchAuditStore,
} from "./searchAuditStore";

export const DEFAULT_SEARCH_AUDIT_COLLECTION = "search_audit_logs";
export const DEFAULT_SEARCH_AUDIT_WRITE_TIMEOUT_MS = 1000;

export interface MongoSearchAuditStoreOptions {
  mongoUrl: string;
  dbName: string;
  collectionName: string;
  writeTimeoutMs?: number;
}

interface MongoSearchAuditRuntime {
  client: MongoClientType | null;
  collectionPromise: Promise<Collection<SearchAuditRecord>> | null;
}

const MONGO_SEARCH_AUDIT_RUNTIME_KEY = "__panhub_mongo_search_audit_runtime__";
const SEARCH_AUDIT_INDEXES = [
  { key: { ip: 1, searchedAt: -1 } },
  { key: { normalizedKeyword: 1, searchedAt: -1 } },
  { key: { searchedAt: -1 } },
  { key: { ip: 1, normalizedKeyword: 1, searchedAt: -1 } },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
];

function getRuntime(): MongoSearchAuditRuntime {
  const globalState = globalThis as typeof globalThis & {
    [MONGO_SEARCH_AUDIT_RUNTIME_KEY]?: MongoSearchAuditRuntime;
  };

  if (!globalState[MONGO_SEARCH_AUDIT_RUNTIME_KEY]) {
    globalState[MONGO_SEARCH_AUDIT_RUNTIME_KEY] = {
      client: null,
      collectionPromise: null,
    };
  }

  return globalState[MONGO_SEARCH_AUDIT_RUNTIME_KEY];
}

function normalizeWriteTimeoutMs(value?: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : DEFAULT_SEARCH_AUDIT_WRITE_TIMEOUT_MS;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchAuditFilter(query: SearchAuditQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.ip) {
    filter.ip = query.ip;
  }
  if (query.keyword) {
    const normalized = query.keyword.trim().replace(/\s+/g, " ");
    if (normalized) {
      filter.normalizedKeyword = { $regex: escapeRegExp(normalized), $options: "i" };
    }
  }
  if (query.method) {
    filter.method = query.method;
  }
  if (typeof query.statusCode === "number") {
    filter.statusCode = query.statusCode;
  }
  if (typeof query.success === "boolean") {
    filter.success = query.success;
  }
  const range: Record<string, Date> = {};
  if (query.from) {
    range.$gte = query.from;
  }
  if (query.to) {
    range.$lte = query.to;
  }
  if (Object.keys(range).length > 0) {
    filter.searchedAt = range;
  }
  return filter;
}

function normalizePaging(options: SearchAuditQueryOptions): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(options.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(options.pageSize) || 50));
  return { page, pageSize };
}

function createIndexes(
  collection: Collection<SearchAuditRecord>,
  timeoutMs: number
): Promise<string[]> {
  return collection.createIndexes(SEARCH_AUDIT_INDEXES, {
    timeoutMS: timeoutMs,
  });
}

function getMongoDriverName(): string {
  return "mongodb";
}

async function createMongoClient(
  options: Required<MongoSearchAuditStoreOptions>
): Promise<MongoClientType> {
  const { MongoClient } = await import(getMongoDriverName());
  return new MongoClient(options.mongoUrl, {
    connectTimeoutMS: options.writeTimeoutMs,
    serverSelectionTimeoutMS: options.writeTimeoutMs,
  });
}

async function getOrCreateCollection(
  options: Required<MongoSearchAuditStoreOptions>
): Promise<Collection<SearchAuditRecord>> {
  const runtime = getRuntime();
  if (runtime.collectionPromise) {
    return runtime.collectionPromise;
  }

  runtime.collectionPromise = (async () => {
    const client = runtime.client ?? (await createMongoClient(options));
    runtime.client = client;
    await client.connect();
    const collection = client
      .db(options.dbName)
      .collection<SearchAuditRecord>(options.collectionName);
    await createIndexes(collection, options.writeTimeoutMs);
    return collection;
  })().catch((error) => {
    runtime.client = null;
    runtime.collectionPromise = null;
    throw error;
  });

  return runtime.collectionPromise;
}

class MongoSearchAuditStore implements SearchAuditStore {
  private options: Required<MongoSearchAuditStoreOptions>;

  constructor(options: MongoSearchAuditStoreOptions) {
    this.options = {
      ...options,
      collectionName: options.collectionName || DEFAULT_SEARCH_AUDIT_COLLECTION,
      writeTimeoutMs: normalizeWriteTimeoutMs(options.writeTimeoutMs),
    };
  }

  async insert(record: SearchAuditRecord): Promise<void> {
    const collection = await getOrCreateCollection(this.options);
    await collection.insertOne(record, {
      timeoutMS: this.options.writeTimeoutMs,
    });
  }

  async find(
    query: SearchAuditQuery,
    options: SearchAuditQueryOptions
  ): Promise<SearchAuditQueryResult> {
    const collection = await getOrCreateCollection(this.options);
    const filter = buildSearchAuditFilter(query);
    const { page, pageSize } = normalizePaging(options);
    const maxTimeMS = this.options.writeTimeoutMs;

    const [items, total] = await Promise.all([
      collection
        .find(filter, { maxTimeMS })
        .sort({ searchedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter, { maxTimeMS }),
    ]);

    return { items, total, page, pageSize };
  }

  async stats(): Promise<SearchAuditStatsResult> {
    const collection = await getOrCreateCollection(this.options);
    const maxTimeMS = this.options.writeTimeoutMs;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [total, successCount, byMethod, byStatusCode, daily] = await Promise.all([
      collection.countDocuments({}, { maxTimeMS }),
      collection.countDocuments({ success: true }, { maxTimeMS }),
      collection
        .aggregate<SearchAuditStatsBucket<string>>([
          { $group: { _id: "$method", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ], { maxTimeMS })
        .toArray(),
      collection
        .aggregate<SearchAuditStatsBucket<number>>([
          { $group: { _id: "$statusCode", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ], { maxTimeMS })
        .toArray(),
      collection
        .aggregate<SearchAuditStatsBucket<string>>([
          { $match: { searchedAt: { $gte: since } } },
          { $group: { _id: "$dayBucket", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ], { maxTimeMS })
        .toArray(),
    ]);

    return {
      total,
      successCount,
      failureCount: total - successCount,
      byMethod,
      byStatusCode,
      daily,
    };
  }
}

export function createMongoSearchAuditStore(
  options: MongoSearchAuditStoreOptions
): SearchAuditStore {
  return new MongoSearchAuditStore(options);
}

export function resetMongoSearchAuditRuntime(): void {
  delete (globalThis as Record<string, unknown>)[MONGO_SEARCH_AUDIT_RUNTIME_KEY];
}
