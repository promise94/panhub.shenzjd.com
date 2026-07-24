import type {
  SearchAuditQuery,
  SearchAuditQueryOptions,
  SearchAuditQueryResult,
  SearchAuditRecord,
  SearchAuditStatsResult,
  SearchAuditStore,
  SearchAuditWriteInput,
} from "./searchAuditStore";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SEARCH_AUDIT_RETENTION_DAYS = 360;
export const MAX_SEARCH_AUDIT_USER_AGENT_LENGTH = 512;
export const MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH = 512;

export interface SearchAuditServiceOptions {
  store: SearchAuditStore;
  retentionDays?: number;
}

function normalizeKeyword(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ");
}

function normalizeList(values?: string[] | null): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => value.trim())
    .filter(Boolean);
}

function limitText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.slice(0, maxLength);
}

function toDayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDurationMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

export class SearchAuditService {
  private store: SearchAuditStore;
  private retentionDays: number;

  constructor(options: SearchAuditServiceOptions) {
    this.store = options.store;
    this.retentionDays = options.retentionDays ?? DEFAULT_SEARCH_AUDIT_RETENTION_DAYS;
  }

  async record(input: SearchAuditWriteInput): Promise<SearchAuditRecord> {
    const searchedAt = new Date(input.startedAt.getTime());
    const createdAt = new Date(input.finishedAt.getTime());
    const record: SearchAuditRecord = {
      searchedAt,
      createdAt,
      expiresAt: new Date(searchedAt.getTime() + this.retentionDays * DAY_MS),
      dayBucket: toDayBucket(searchedAt),
      ip: input.meta.ip,
      keyword: input.input.keyword,
      normalizedKeyword: normalizeKeyword(input.input.keyword),
      method: input.meta.method,
      path: input.meta.path,
      source: input.input.source,
      channels: normalizeList(input.input.channels),
      plugins: normalizeList(input.input.plugins),
      cloudTypes: normalizeList(input.input.cloudTypes),
      userAgent: limitText(input.meta.userAgent, MAX_SEARCH_AUDIT_USER_AGENT_LENGTH),
      requestId: input.meta.requestId ?? null,
      success: input.outcome.success,
      statusCode: input.outcome.statusCode,
      durationMs: toDurationMs(searchedAt, createdAt),
      resultCount: input.outcome.resultCount ?? null,
      refresh: input.input.refresh,
      errorMessage: input.outcome.success
        ? null
        : limitText(input.outcome.errorMessage, MAX_SEARCH_AUDIT_ERROR_MESSAGE_LENGTH),
    };

    await this.store.insert(record);
    return record;
  }

  async query(
    query: SearchAuditQuery,
    options: SearchAuditQueryOptions
  ): Promise<SearchAuditQueryResult> {
    return this.store.find(query, options);
  }

  async stats(): Promise<SearchAuditStatsResult> {
    return this.store.stats();
  }
}
