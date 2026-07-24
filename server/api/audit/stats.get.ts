import { createError, defineEventHandler } from "h3";
import { getOrCreateSearchAuditService } from "../../core/services";
import type { GenericResponse } from "../../core/types/models";
import { requireAuditAdmin } from "../../utils/auditAuth";

export default defineEventHandler(async (event) => {
  requireAuditAdmin(event);

  const config = useRuntimeConfig();
  const service = getOrCreateSearchAuditService(config);
  if (!service) {
    throw createError({ statusCode: 503, statusMessage: "search audit disabled" });
  }

  const stats = await service.stats();
  const response: GenericResponse<typeof stats> = {
    code: 0,
    message: "success",
    data: stats,
  };
  return response;
});
