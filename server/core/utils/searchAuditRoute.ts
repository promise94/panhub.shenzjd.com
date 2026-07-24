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
