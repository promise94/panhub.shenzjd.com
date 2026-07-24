import { defineEventHandler } from "h3";
import type { GenericResponse } from "../../core/types/models";
import { isAuditAdminEnabled, requireAuditAdmin } from "../../utils/auditAuth";

export default defineEventHandler(async (event) => {
  const enabled = isAuditAdminEnabled(event);
  let loggedIn = false;

  if (enabled) {
    try {
      requireAuditAdmin(event);
      loggedIn = true;
    } catch {
      loggedIn = false;
    }
  }

  const response: GenericResponse<{ enabled: boolean; loggedIn: boolean }> = {
    code: 0,
    message: "success",
    data: { enabled, loggedIn },
  };
  return response;
});
