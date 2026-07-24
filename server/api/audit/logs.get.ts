import { createError, defineEventHandler, getQuery } from "h3";
import { getOrCreateSearchAuditService } from "../../core/services";
import type { SearchAuditQuery } from "../../core/services/searchAuditStore";
import type { GenericResponse } from "../../core/types/models";
import { requireAuditAdmin } from "../../utils/auditAuth";

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default defineEventHandler(async (event) => {
  requireAuditAdmin(event);

  const config = useRuntimeConfig();
  const service = getOrCreateSearchAuditService(config);
  if (!service) {
    throw createError({ statusCode: 503, statusMessage: "search audit disabled" });
  }

  const query = getQuery(event);
  const auditQuery: SearchAuditQuery = {};

  if (typeof query.ip === "string" && query.ip.trim()) {
    auditQuery.ip = query.ip.trim();
  }
  if (typeof query.keyword === "string" && query.keyword.trim()) {
    auditQuery.keyword = query.keyword.trim();
  }
  if (typeof query.method === "string" && query.method.trim()) {
    auditQuery.method = query.method.trim();
  }
  if (typeof query.statusCode === "string" && query.statusCode.trim()) {
    const code = Number(query.statusCode);
    if (Number.isInteger(code)) {
      auditQuery.statusCode = code;
    }
  }
  if (typeof query.success === "string") {
    if (query.success === "true") auditQuery.success = true;
    else if (query.success === "false") auditQuery.success = false;
  }

  const from = parseDate(query.from);
  if (from) auditQuery.from = from;
  const to = parseDate(query.to);
  if (to) auditQuery.to = to;

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));

  const result = await service.query(auditQuery, { page, pageSize });
  const response: GenericResponse<typeof result> = {
    code: 0,
    message: "success",
    data: result,
  };
  return response;
});
