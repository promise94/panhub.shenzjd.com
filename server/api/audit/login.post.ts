import { createError, defineEventHandler, readBody } from "h3";
import {
  isAuditAdminEnabled,
  setAuditAdminCookie,
  verifyAuditAdminToken,
} from "../../utils/auditAuth";
import type { GenericResponse } from "../../core/types/models";

export default defineEventHandler(async (event) => {
  if (!isAuditAdminEnabled(event)) {
    throw createError({ statusCode: 404, statusMessage: "audit admin disabled" });
  }

  const body = await readBody<{ token?: unknown }>(event);
  const token = typeof body?.token === "string" ? body.token : "";

  if (!verifyAuditAdminToken(event, token)) {
    throw createError({ statusCode: 401, statusMessage: "invalid audit admin token" });
  }

  setAuditAdminCookie(event, token.trim());
  const response: GenericResponse<{ ok: true }> = {
    code: 0,
    message: "success",
    data: { ok: true },
  };
  return response;
});
