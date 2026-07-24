# Search Audit MongoDB Design

## Overview

This document defines how PanHub records search request audit data for security review, operations analysis, and rate-limit support.

## Goals

- Record request source IP and search keyword for every search request.
- Support audit queries by IP, keyword, and time range.
- Provide a stable foundation for future rate limiting and simple operations reporting.
- Keep the search API available even if audit storage is temporarily unavailable.

## Non-Goals

- Build a public-facing audit query API.
- Perform heavy real-time analytics in the request path.
- Add in-memory fallback storage.
- Store arbitrary `ext` payloads in audit records.

## Confirmed Decisions

- Use MongoDB as the audit storage.
- Target Docker and Node.js deployments first; Cloudflare-native storage is not required.
- Do not add memory fallback.
- Store one complete audit event per search request.
- Record both successful and failed requests.
- Default retention is 360 days and is configurable.
- Retention changes apply to new records only by default.

## Architecture

### Modules

- `server/core/services/searchAuditStore.ts`
  - Defines the storage interface.
- `server/core/services/mongoSearchAuditStore.ts`
  - Implements MongoDB persistence.
- `server/core/services/searchAuditService.ts`
  - Builds normalized audit documents and delegates writes to the store.
- `server/core/utils/requestMeta.ts`
  - Extracts request metadata such as IP, method, path, and user agent.

### Integration Points

Integrate audit recording in these routes:

- `server/api/search.get.ts`
- `server/api/search.post.ts`

The search service remains focused on search orchestration. Audit capture stays in the API route layer plus the dedicated audit service.

### Request Flow

1. Capture `startTime` and request metadata as soon as the request enters the route.
2. Run auth and request parsing.
3. Run the search service.
4. In `finally`, write one complete audit event.
5. If MongoDB audit write fails, keep the search response behavior unchanged and log the audit failure.

## Data Model

### Collection

- `search_audit_logs`

### Document Shape

```ts
{
  _id: ObjectId,
  searchedAt: Date,
  createdAt: Date,
  expiresAt: Date,
  dayBucket: "2026-06-03",
  ip: "1.2.3.4",
  keyword: "流浪地球",
  normalizedKeyword: "流浪地球",
  method: "GET",
  path: "/api/search",
  source: "all",
  channels: [],
  plugins: [],
  cloudTypes: [],
  userAgent: "...",
  requestId: "...",
  success: true,
  statusCode: 200,
  durationMs: 842,
  resultCount: 12,
  refresh: false,
  errorMessage: null
}
```

### Field Rules

- `keyword` stores the original request keyword.
- `normalizedKeyword` stores the trimmed and whitespace-normalized keyword.
- `channels`, `plugins`, and `cloudTypes` are always arrays.
- `resultCount` is best-effort and may be `null` if the response shape does not allow a stable count.
- `errorMessage` stores a short summary only, not a full stack trace.
- `userAgent` and `errorMessage` should be length-limited before insert.

## Indexes

Create these indexes first:

```js
{ ip: 1, searchedAt: -1 }
{ normalizedKeyword: 1, searchedAt: -1 }
{ searchedAt: -1 }
{ ip: 1, normalizedKeyword: 1, searchedAt: -1 }
```

Create this TTL index for retention:

```js
{ expiresAt: 1 }
```

Do not add indexes for `userAgent`, `channels`, `plugins`, or `cloudTypes` in the first phase.

## Retention

### Default Policy

- Keep raw audit records for 360 days by default.

### Configuration

Use a runtime configuration value backed by environment variables:

```bash
SEARCH_AUDIT_RETENTION_DAYS=360
```

### Expiration Rule

- Compute `expiresAt` when each document is written.
- `expiresAt = searchedAt + retentionDays`
- MongoDB TTL removes expired documents automatically.

### Configuration Change Behavior

- Changing retention affects new records only by default.
- Existing records keep their original `expiresAt`.
- If historical records need a different retention window, handle that through a dedicated maintenance script.

## Error Handling and Performance

- MongoDB audit write failures must not fail the search request.
- Use a process-level shared MongoDB client; do not create one connection per request.
- Write audit data with a single `insertOne` call.
- Avoid heavy work in the request path, such as geolocation, full user-agent parsing, or real-time aggregation.
- Apply a short write timeout to prevent audit persistence from adding unbounded latency.

## Verification

### Functional Checks

- Successful search writes a success audit record.
- Missing `kw` writes a failed audit record with `400`.
- Auth failure writes a failed audit record with the actual auth status.
- Search service exception writes a failed audit record.

### Failure Checks

- MongoDB unavailable: search API still responds according to the original business flow, and audit failure is logged.
- MongoDB slow or timed out: search API is not blocked indefinitely.

### Performance Checks

- Compare search API latency before and after audit integration.
- Confirm tail latency does not regress materially under normal MongoDB availability.

## Rollout Plan

### Phase 1

- Add MongoDB audit persistence.
- Record all search requests with the core fields and indexes.

### Phase 2

- Add internal-only query capabilities for IP, keyword, and time-range lookups.

### Phase 3

- Add lightweight rate-limit and abuse-detection rules using audit data.

### Phase 4

- Add daily aggregate collections or jobs for longer-term reporting.

## Security and Access

- Audit data must only be exposed to internal tools or protected admin APIs.
- Do not expose raw IP-based audit queries publicly.
- Document the collection and retention of IP and keyword data in the privacy-facing project documentation when this feature ships.

## Decision Log

- 2026-06-03: Chose MongoDB over worker-native storage because the target runtime is Docker and Node.js first.
- 2026-06-03: Rejected memory fallback to avoid split persistence behavior.
- 2026-06-03: Set default retention to 360 days with configuration support.
- 2026-06-03: Retention configuration changes apply to new records only by default.
