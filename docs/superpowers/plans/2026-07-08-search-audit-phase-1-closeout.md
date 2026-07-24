# Search Audit Phase 1 Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Phase 1 search audit gaps by logging failed audit writes, covering GET auth-failure auditing, documenting privacy-facing collection details, and reporting unrelated working-tree changes.

**Architecture:** Keep the existing audit architecture intact: API routes call `scheduleSearchAudit()`, which schedules `SearchAuditService.record()` without blocking the response. Add logging inside the route helper rather than changing the Mongo store or route control flow. Documentation changes stay in README because the project currently exposes environment-variable and user-facing deployment notes there.

**Tech Stack:** Nuxt 4 / Nitro server routes, h3, TypeScript, Vitest, MongoDB driver, pnpm.

---

## File Structure

- Modify `server/core/utils/searchAuditRoute.ts`
  - Responsibility: shared route helper for audit input parsing, result-count extraction, error-to-outcome conversion, and background scheduling. Add non-blocking warning logs when audit scheduling or recording fails.
- Modify `test/unit/searchApiAudit.test.ts`
  - Responsibility: route-level audit behavior tests with mocked h3/auth/service dependencies. Add GET auth-failure coverage and audit failure logging coverage.
- Modify `README.md`
  - Responsibility: human-facing configuration and privacy/deployment documentation. Add a concise search audit privacy note after the environment variable table.
- Inspect but do not modify without explicit approval:
  - `.claude/settings.local.json`
  - `data/hot-searches.json`
  - `pnpm-workspace.yaml`

---

### Task 1: Add a failing test for logging rejected audit writes

**Files:**
- Modify: `test/unit/searchApiAudit.test.ts`
- Later modify: `server/core/utils/searchAuditRoute.ts`

- [ ] **Step 1: Add the failing test**

In `test/unit/searchApiAudit.test.ts`, append this test inside the existing `describe("search API audit routes", () => { ... })` block, after the existing `keeps the original success response when audit recording rejects` test:

```ts
  it("logs a warning when audit recording rejects", async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

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
        "[API] Search audit recording failed",
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
```

- [ ] **Step 2: Run test to verify it fails for the expected reason**

Run:

```bash
pnpm test -- test/unit/searchApiAudit.test.ts -t "logs a warning when audit recording rejects"
```

Expected result:

```text
FAIL test/unit/searchApiAudit.test.ts > search API audit routes > logs a warning when audit recording rejects
AssertionError: expected "warn" to be called with arguments: ...
```

The failure must be about `console.warn` not being called. If the test fails due to TypeScript syntax, import errors, or route response changes, fix the test setup and run it again until it fails because the warning is missing.

- [ ] **Step 3: Implement the minimal logging behavior**

Modify `server/core/utils/searchAuditRoute.ts` to import `loggers` and log warning details for rejected audit writes and synchronous scheduling errors. Replace the current file content with this complete version:

```ts
import type { H3Event } from "h3";
import type {
  SearchAuditOutcomeInput,
  SearchAuditWriteInput,
} from "../services/searchAuditStore";
import type { SearchResponse } from "../types/models";
import { loggers } from "./logger";

type SearchAuditRecorder = {
  record(input: SearchAuditWriteInput): Promise<unknown>;
};

function toAuditErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "unknown error";
  }

  return typeof error === "string" ? error : "unknown error";
}

function logAuditFailure(
  error: unknown,
  input: Omit<SearchAuditWriteInput, "finishedAt">
): void {
  loggers.api.warn("Search audit recording failed", {
    error: toAuditErrorMessage(error),
    requestId: input.meta.requestId ?? null,
    path: input.meta.path,
  });
}

export function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

export function parseBodyList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }

  if (typeof value === "string") {
    return parseCsvList(value);
  }

  return undefined;
}

export function getResultCount(result: SearchResponse): number | null {
  if (typeof result.total === "number") {
    return result.total;
  }

  return Array.isArray(result.results) ? result.results.length : null;
}

export function getAuditOutcomeFromError(error: unknown): SearchAuditOutcomeInput {
  if (error instanceof Error) {
    const cause = error as Error & { statusCode?: number; statusMessage?: string };
    return {
      success: false,
      statusCode: typeof cause.statusCode === "number" ? cause.statusCode : 500,
      errorMessage: cause.statusMessage || cause.message || "unknown error",
    };
  }

  return {
    success: false,
    statusCode: 500,
    errorMessage: typeof error === "string" ? error : "unknown error",
  };
}

export function scheduleSearchAudit(
  event: H3Event,
  auditService: SearchAuditRecorder | null,
  input: Omit<SearchAuditWriteInput, "finishedAt">
): void {
  if (!auditService) {
    return;
  }

  try {
    const task = Promise.resolve()
      .then(() =>
        auditService.record({
          ...input,
          finishedAt: new Date(),
        })
      )
      .catch((error) => {
        logAuditFailure(error, input);
      });

    if (typeof event.waitUntil === "function") {
      event.waitUntil(task);
    }
  } catch (error) {
    logAuditFailure(error, input);
  }
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
pnpm test -- test/unit/searchApiAudit.test.ts -t "logs a warning when audit recording rejects"
```

Expected result:

```text
PASS test/unit/searchApiAudit.test.ts > search API audit routes > logs a warning when audit recording rejects
```

- [ ] **Step 5: Run the route audit test file**

Run:

```bash
pnpm test -- test/unit/searchApiAudit.test.ts
```

Expected result:

```text
PASS test/unit/searchApiAudit.test.ts
```

---

### Task 2: Add GET auth-failure audit coverage

**Files:**
- Modify: `test/unit/searchApiAudit.test.ts`

- [ ] **Step 1: Add the GET auth-failure test**

In `test/unit/searchApiAudit.test.ts`, append this test inside the existing `describe("search API audit routes", () => { ... })` block, near the existing POST auth-failure test:

```ts
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
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
pnpm test -- test/unit/searchApiAudit.test.ts -t "writes a 401 audit record when GET auth fails"
```

Expected result:

```text
PASS test/unit/searchApiAudit.test.ts > search API audit routes > writes a 401 audit record when GET auth fails
```

If this passes immediately, keep the test: this task is coverage for already-existing behavior, not a production behavior change. If it fails, inspect the failure and only change production code if the failure shows GET auth failures are not being audited.

- [ ] **Step 3: Run the route audit test file**

Run:

```bash
pnpm test -- test/unit/searchApiAudit.test.ts
```

Expected result:

```text
PASS test/unit/searchApiAudit.test.ts
```

---

### Task 3: Document search audit privacy behavior in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the README section**

In `README.md`, insert this section after the existing MongoDB audit note that ends with `若 Mongo 配置缺失，则该功能保持关闭。`:

```md
### 搜索审计与隐私说明

配置 `SEARCH_AUDIT_MONGO_URL` 与 `SEARCH_AUDIT_MONGO_DB` 后，服务端会把每次 `/api/search` 请求写入 MongoDB 审计集合，用于安全审查、运维分析和后续限流能力。审计记录包含搜索关键词、来源 IP、请求方法、路径、User-Agent、请求 ID、成功状态、状态码、耗时、结果数量和筛选条件，不保存 `ext` 扩展 payload。

默认保留周期为 360 天，可通过 `SEARCH_AUDIT_RETENTION_DAYS` 调整；保留周期按写入时计算，只影响新记录。未配置 MongoDB 审计环境变量时不会启用该功能，也不会使用内存审计 fallback。
```

- [ ] **Step 2: Run a static documentation check**

Run:

```bash
git diff -- README.md
```

Expected result:

```text
+### 搜索审计与隐私说明
+配置 `SEARCH_AUDIT_MONGO_URL` 与 `SEARCH_AUDIT_MONGO_DB` 后，服务端会把每次 `/api/search` 请求写入 MongoDB 审计集合...
```

Also verify the section uses hierarchical headings: it is under `## ⚙️ 环境变量`, so `### 搜索审计与隐私说明` is correct.

---

### Task 4: Report unrelated working-tree changes without reverting them

**Files:**
- Inspect only unless the user separately approves changes:
  - `.claude/settings.local.json`
  - `data/hot-searches.json`
  - `pnpm-workspace.yaml`

- [ ] **Step 1: Inspect changed files**

Run:

```bash
git status --short
```

Expected result includes the search audit files and may include unrelated files:

```text
 M .claude/settings.local.json
 M data/hot-searches.json
 M pnpm-workspace.yaml
```

- [ ] **Step 2: Inspect concise diffs for unrelated files**

Run:

```bash
git diff -- .claude/settings.local.json data/hot-searches.json pnpm-workspace.yaml
```

Expected result: diffs are shown for review. Do not modify or revert these files without explicit user approval.

- [ ] **Step 3: Include the findings in the final report**

Final report must include this wording or equivalent:

```md
仍有这些看起来不直接属于搜索审计 Phase 1 的工作区变更，我未擅自回滚：`.claude/settings.local.json`、`data/hot-searches.json`、`pnpm-workspace.yaml`。如果你希望我拆分/回滚其中某些文件，请单独确认。
```

---

### Task 5: Final verification

**Files:**
- Verify all touched source, tests, and README changes.

- [ ] **Step 1: Run focused audit tests**

Run:

```bash
pnpm test -- test/unit/searchAuditService.test.ts test/unit/requestMeta.test.ts test/unit/mongoSearchAuditStore.test.ts test/unit/searchApiAudit.test.ts
```

Expected result:

```text
PASS test/unit/searchAuditService.test.ts
PASS test/unit/requestMeta.test.ts
PASS test/unit/mongoSearchAuditStore.test.ts
PASS test/unit/searchApiAudit.test.ts
```

Note: Vitest may also discover and run other unit tests because of the project config and CLI argument handling. If that happens, all discovered tests must pass or the failure must be reported honestly.

- [ ] **Step 2: Run full unit test suite if time allows**

Run:

```bash
pnpm test
```

Expected result:

```text
Test Files ... passed
Tests ... passed
```

If full suite is not run, final report must state the exact command not run, why it was skipped, and residual risk.

- [ ] **Step 3: Inspect final diff summary**

Run:

```bash
git diff --stat HEAD
git status --short
```

Expected result: source/test/README changes are present; unrelated pre-existing working-tree changes may still be present and must be reported.

---

## Self-Review

- Spec coverage:
  - MongoDB audit write failures must not fail search request and must be logged: Task 1.
  - GET auth failure writes failed audit record: Task 2.
  - Privacy-facing documentation for IP and keyword collection/retention: Task 3.
  - Unrelated working-tree changes are not silently modified: Task 4.
  - Verification evidence: Task 5.
- Placeholder scan: no `TBD`, `TODO`, `similar to above`, or unspecified implementation steps remain.
- Type consistency:
  - `scheduleSearchAudit()` still accepts `H3Event`, nullable recorder, and `Omit<SearchAuditWriteInput, "finishedAt">`.
  - Logger call uses existing `loggers.api.warn()` shape from `server/core/utils/logger.ts`.
  - Tests use existing mocks: `recordMock`, `requireSearchAuthMock`, `getQueryMock`, `searchPostHandler`, and `searchGetHandler`.
