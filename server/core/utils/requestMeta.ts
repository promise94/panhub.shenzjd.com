import type { H3Event } from "h3";
import type { SearchAuditMetaInput } from "../services/searchAuditStore";

type RequestHeaderValue = string | string[] | undefined;

function getHeaderValue(event: H3Event, name: string): string | null {
  const value = event.node.req.headers[name] as RequestHeaderValue;

  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  return null;
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  return trimmedValue.startsWith("::ffff:")
    ? trimmedValue.slice("::ffff:".length)
    : trimmedValue;
}

function isPrivateOrLocalIp(value: string | null): boolean {
  if (!value) {
    return false;
  }

  if (value === "::1" || value.toLowerCase() === "localhost") {
    return true;
  }

  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return value.toLowerCase().startsWith("fc") || value.toLowerCase().startsWith("fd");
  }

  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function getForwardedIp(event: H3Event): string | null {
  const forwardedFor = getHeaderValue(event, "x-forwarded-for");
  const forwardedIp = forwardedFor?.split(",")[0] ?? null;
  return normalizeIp(forwardedIp) ?? normalizeIp(getHeaderValue(event, "x-real-ip"));
}

function getRequestIp(event: H3Event): string {
  const remoteAddress = normalizeIp(event.node.req.socket?.remoteAddress);
  const forwardedIp = getForwardedIp(event);

  if (!remoteAddress) {
    return "unknown";
  }

  if (isPrivateOrLocalIp(remoteAddress) && forwardedIp) {
    return forwardedIp;
  }

  return remoteAddress;
}

function getRequestId(event: H3Event): string {
  return (
    getHeaderValue(event, "x-request-id") ||
    getHeaderValue(event, "request-id") ||
    globalThis.crypto.randomUUID()
  );
}

function getRequestPath(event: H3Event): string {
  const rawPath = event.path || event.node.req.url || "/";
  return rawPath.split("?", 1)[0] || "/";
}

export function getRequestMeta(event: H3Event): SearchAuditMetaInput {
  return {
    ip: getRequestIp(event),
    method: event.method || event.node.req.method || "GET",
    path: getRequestPath(event),
    userAgent: getHeaderValue(event, "user-agent"),
    requestId: getRequestId(event),
  };
}
