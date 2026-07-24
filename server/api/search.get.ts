import { createError, defineEventHandler, getQuery } from "h3";
import { requireSearchAuth } from "../utils/requireAuth";
import {
  getOrCreateSearchAuditService,
  getOrCreateSearchService,
} from "../core/services";
import type { SearchAuditInput } from "../core/services/searchAuditStore";
import type { GenericResponse, SearchRequest } from "../core/types/models";
import { getRequestMeta } from "../core/utils/requestMeta";
import {
  getAuditOutcomeFromError,
  getResultCount,
  parseCsvList,
  scheduleSearchAudit,
} from "../core/utils/searchAuditRoute";

/** 从 H3 event 中提取客户端断开信号（兼容 h3 无 getAbortSignal 的版本） */
function getClientAbortSignal(event: any): AbortSignal | undefined {
  if (typeof event._signal === "object" && event._signal instanceof AbortSignal) {
    return event._signal;
  }
  const req = event.node?.req;
  if (req && typeof req.on === "function") {
    const controller = new AbortController();
    req.on("close", () => {
      if (req.destroyed || (req.writableEnded === false && req.readableEnded)) {
        controller.abort();
      }
    });
    return controller.signal;
  }
  return undefined;
}

export default defineEventHandler(async (event) => {
  const startedAt = new Date();
  const config = useRuntimeConfig();
  const meta = getRequestMeta(event);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  const auditInput: SearchAuditInput = {
    keyword: (q.kw as string) || "",
    source: ((q.src as string) || "all") as SearchAuditInput["source"],
    channels: parseCsvList(q.channels as string | undefined),
    plugins: parseCsvList(q.plugins as string | undefined),
    cloudTypes: parseCsvList(q.cloud_types as string | undefined),
    refresh: String(q.refresh).trim() === "true",
  };

  try {
    requireSearchAuth(event);
    const service = getOrCreateSearchService(config);

    if (!kw) {
      throw createError({ statusCode: 400, statusMessage: "kw is required" });
    }
    if (kw.length > 200) {
      throw createError({ statusCode: 400, statusMessage: "kw too long (max 200)" });
    }

    let ext: Record<string, any> | undefined;
    const extStr = (q.ext as string | undefined)?.trim();
    if (extStr) {
      if (extStr === "{}") ext = {};
      else {
        try {
          ext = JSON.parse(extStr);
        } catch {
          throw createError({ statusCode: 400, statusMessage: "invalid ext json" });
        }
      }
    }

    const req: SearchRequest = {
      kw,
      channels: auditInput.channels,
      conc: (() => {
        const n = q.conc ? parseInt(String(q.conc), 10) : NaN;
        return Number.isFinite(n) && n >= 1 && n <= 16 ? n : undefined;
      })(),
      refresh: auditInput.refresh,
      res: (q.res as any) || "merged_by_type",
      src: auditInput.source,
      plugins: auditInput.plugins,
      cloud_types: auditInput.cloudTypes,
      ext,
    };

    if (req.src === "tg") req.plugins = undefined;
    else if (req.src === "plugin") req.channels = undefined;
    if (!req.res || req.res === "merge") req.res = "merged_by_type";

    const signal = getClientAbortSignal(event);

    const { response: result, warnings } = await service.searchWithWarnings(
      req.kw,
      req.channels,
      req.conc,
      !!req.refresh,
      req.res,
      req.src,
      req.plugins,
      req.cloud_types,
      req.ext || {},
      signal
    );

    const resp: GenericResponse<typeof result> = {
      code: 0,
      message: warnings.length > 0 ? "partial_success" : "success",
      data: result,
    };

    if (warnings.length > 0) {
      (resp as any).warnings = warnings;
    }

    scheduleSearchAudit(event, getOrCreateSearchAuditService(config), {
      startedAt,
      meta,
      input: auditInput,
      outcome: { success: true, statusCode: 200, resultCount: getResultCount(result) },
    });

    return resp;
  } catch (error) {
    scheduleSearchAudit(event, getOrCreateSearchAuditService(config), {
      startedAt,
      meta,
      input: auditInput,
      outcome: getAuditOutcomeFromError(error),
    });
    throw error;
  }
});
