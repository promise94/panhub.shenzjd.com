export type SearchAuditSource = "all" | "tg" | "plugin";

export interface SearchAuditRecord {
  searchedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  dayBucket: string;
  ip: string;
  keyword: string;
  normalizedKeyword: string;
  method: string;
  path: string;
  source: SearchAuditSource;
  channels: string[];
  plugins: string[];
  cloudTypes: string[];
  userAgent: string | null;
  requestId: string | null;
  success: boolean;
  statusCode: number;
  durationMs: number;
  resultCount: number | null;
  refresh: boolean;
  errorMessage: string | null;
}

export interface SearchAuditMetaInput {
  ip: string;
  method: string;
  path: string;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface SearchAuditInput {
  keyword: string;
  source: SearchAuditSource;
  channels?: string[] | null;
  plugins?: string[] | null;
  cloudTypes?: string[] | null;
  refresh: boolean;
}

export interface SearchAuditOutcomeInput {
  success: boolean;
  statusCode: number;
  resultCount?: number | null;
  errorMessage?: string | null;
}

export interface SearchAuditWriteInput {
  startedAt: Date;
  finishedAt: Date;
  meta: SearchAuditMetaInput;
  input: SearchAuditInput;
  outcome: SearchAuditOutcomeInput;
}

export interface SearchAuditQuery {
  ip?: string;
  keyword?: string;
  method?: string;
  statusCode?: number;
  success?: boolean;
  from?: Date;
  to?: Date;
}

export interface SearchAuditQueryOptions {
  page: number;
  pageSize: number;
}

export interface SearchAuditQueryResult {
  items: SearchAuditRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SearchAuditStatsBucket<T> {
  _id: T;
  count: number;
}

export interface SearchAuditStatsResult {
  total: number;
  successCount: number;
  failureCount: number;
  byMethod: SearchAuditStatsBucket<string>[];
  byStatusCode: SearchAuditStatsBucket<number>[];
  daily: SearchAuditStatsBucket<string>[];
}

export interface SearchAuditStore {
  insert(record: SearchAuditRecord): Promise<void>;
  find(
    query: SearchAuditQuery,
    options: SearchAuditQueryOptions
  ): Promise<SearchAuditQueryResult>;
  stats(): Promise<SearchAuditStatsResult>;
}
