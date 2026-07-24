import type { H3Event } from "h3";
import { createError, getCookie, setHeader } from "h3";
import { createAuthToken, verifyAuthToken } from "./auth";

const AUDIT_COOKIE_NAME = "panhub_audit_admin";
const AUDIT_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天
const AUDIT_COOKIE_PATH = "/";

export function isAuditAdminEnabled(event: H3Event): boolean {
  const config = useRuntimeConfig();
  const adminToken = (config.searchAuditAdminToken as string) || "";
  return adminToken.trim().length > 0;
}

export function requireAuditAdmin(event: H3Event): void {
  const config = useRuntimeConfig();
  const adminToken = (config.searchAuditAdminToken as string) || "";
  if (!adminToken.trim()) {
    throw createError({ statusCode: 404, statusMessage: "audit admin disabled" });
  }

  const cookie = getCookie(event, AUDIT_COOKIE_NAME);
  if (!cookie || !verifyAuthToken(cookie, adminToken)) {
    throw createError({ statusCode: 401, statusMessage: "audit admin required" });
  }
}

export function verifyAuditAdminToken(event: H3Event, token: string): boolean {
  const config = useRuntimeConfig();
  const adminToken = (config.searchAuditAdminToken as string) || "";
  if (!adminToken.trim()) return false;
  return token.trim() === adminToken.trim();
}

export function setAuditAdminCookie(event: H3Event, secret: string): void {
  const token = createAuthToken(secret);
  setHeader(event, "Set-Cookie", [
    `${AUDIT_COOKIE_NAME}=${token}; Path=${AUDIT_COOKIE_PATH}; Max-Age=${AUDIT_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
  ].join(""));
}

export function clearAuditAdminCookie(event: H3Event): void {
  setHeader(event, "Set-Cookie", [
    `${AUDIT_COOKIE_NAME}=; Path=${AUDIT_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
  ].join(""));
}
