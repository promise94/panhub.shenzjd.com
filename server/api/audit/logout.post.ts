import { defineEventHandler } from "h3";
import { clearAuditAdminCookie } from "../../utils/auditAuth";
import type { GenericResponse } from "../../core/types/models";

export default defineEventHandler(async (event) => {
  clearAuditAdminCookie(event);
  const response: GenericResponse<{ ok: true }> = {
    code: 0,
    message: "success",
    data: { ok: true },
  };
  return response;
});
