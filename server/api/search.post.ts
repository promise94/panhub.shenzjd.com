import { createError, defineEventHandler, readBody } from "h3";
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
  parseBodyList,
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

function buildAuditInput(body: SearchRequest): SearchAuditInput {
  const source = ((body.src as string) || "all") as SearchAuditInput["source"];
  const channels = parseBodyList((body as any).channels);
  const plugins = parseBodyList((body as any).plugins);
  return {
    keyword: typeof body.kw === "string" ? body.kw : "",
    source,
    channels: source === "plugin" ? undefined : channels,
    plugins: source === "tg" ? undefined : plugins,
    cloudTypes: parseBodyList((body as any).cloud_types),
    refresh: !!body.refresh,
  };
}

export default defineEventHandler(async (event) => {
  const startedAt = new Date();
  const config = useRuntimeConfig();
  const meta = getRequestMeta(event);
  let body = {} as SearchRequest;

  try {
    requireSearchAuth(event);
    const service = getOrCreateSearchService(config);
    body = (await readBody<SearchRequest>(event)) || ({} as SearchRequest);

    const kw = (body.kw || "").trim();
    if (!kw) {
      throw createError({ statusCode: 400, statusMessage: "kw is required" });
    }

    body.channels = parseBodyList((body as any).channels);
    body.plugins = parseBodyList((body as any).plugins);
    body.cloud_types = parseBodyList((body as any).cloud_types);

    if (!body.res || body.res === "merge") body.res = "merged_by_type";
    if (!body.src) body.src = "all";
    if (body.src === "tg") body.plugins = undefined;
    else if (body.src === "plugin") body.channels = undefined;

    const signal = getClientAbortSignal(event);

    const { response: result, warnings } = await service.searchWithWarnings(
      kw,
      body.channels,
      body.conc,
      !!body.refresh,
      body.res,
      body.src,
      body.plugins,
      body.cloud_types,
      body.ext || {},
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
      input: buildAuditInput(body),
      outcome: { success: true, statusCode: 200, resultCount: getResultCount(result) },
    });

    return resp;
  } catch (error) {
    scheduleSearchAudit(event, getOrCreateSearchAuditService(config), {
      startedAt,
      meta,
      input: buildAuditInput(body),
      outcome: getAuditOutcomeFromError(error),
    });
    throw error;
  }
});
