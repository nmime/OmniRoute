import { generateRequestId } from "@/shared/utils/requestId";
import { classifyRoute } from "./classify";
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
  AUTHZ_HEADER_AUTH_SCOPES,
  AUTHZ_HEADER_REQUEST_ID,
  AUTHZ_HEADER_ROUTE_CLASS,
} from "./headers";
import { clientApiPolicy } from "./policies/clientApi";
import type { AuthSubject, RouteClassification } from "./types";

function authErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  classification: RouteClassification
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        correlation_id: requestId,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        [AUTHZ_HEADER_REQUEST_ID]: requestId,
        [AUTHZ_HEADER_ROUTE_CLASS]: classification.routeClass,
      },
    }
  );
}

function stampSubject(headers: Headers, subject: AuthSubject): void {
  headers.set(AUTHZ_HEADER_AUTH_KIND, subject.kind);
  headers.set(AUTHZ_HEADER_AUTH_ID, subject.id);
  if (subject.label) headers.set(AUTHZ_HEADER_AUTH_LABEL, subject.label);
  if (subject.scopes && subject.scopes.length > 0) {
    headers.set(AUTHZ_HEADER_AUTH_SCOPES, subject.scopes.join(","));
  }
}

export async function requireClientApiAuth(request: Request): Promise<Response | null> {
  const requestId = request.headers.get(AUTHZ_HEADER_REQUEST_ID) || generateRequestId();
  let pathname = "/api/v1";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // Keep fail-closed CLIENT_API default below.
  }

  const classification = classifyRoute(pathname, request.method);
  const clientClassification: RouteClassification =
    classification.routeClass === "CLIENT_API"
      ? classification
      : {
          routeClass: "CLIENT_API",
          reason: "client_api_v1",
          normalizedPath: classification.normalizedPath || pathname,
        };

  const outcome = await clientApiPolicy.evaluate({
    request,
    classification: clientClassification,
    requestId,
  });

  if (!outcome.allow) {
    return authErrorResponse(
      outcome.status,
      outcome.code,
      outcome.message,
      requestId,
      clientClassification
    );
  }

  try {
    stampSubject(request.headers, outcome.subject);
  } catch {
    // Some Request implementations expose immutable headers. The auth decision is
    // still enforced; middleware stamps mutable forwarded headers in production.
  }

  return null;
}
