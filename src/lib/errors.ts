// Pulls every diagnostically useful field out of arbitrary SDK errors. fal's
// ApiError uses `body.detail`, replicate's errors carry status + response,
// raw fetch failures carry only message — without this, a "500" looks like
// the bare string "HTTP 500" with no hint of which call or what the server said.
export function extractErrorMessage(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;

  const err = e as Record<string, unknown> & {
    name?: string;
    message?: string;
    status?: number;
    statusCode?: number;
    cause?: unknown;
    body?: unknown;
    response?: unknown;
  };

  const parts: string[] = [];

  const status =
    typeof err.status === "number"
      ? err.status
      : typeof err.statusCode === "number"
        ? err.statusCode
        : undefined;
  if (status) parts.push(`HTTP ${status}`);

  const stringify = (v: unknown): string =>
    typeof v === "string"
      ? v
      : (() => {
          try {
            return JSON.stringify(v, null, 2);
          } catch {
            return String(v);
          }
        })();

  // Walk a handful of common shapes. First hit wins per category.
  const body = err.body as Record<string, unknown> | string | undefined;
  if (typeof body === "string" && body.length > 0) {
    parts.push(body);
  } else if (body && typeof body === "object") {
    const detail = (body as Record<string, unknown>).detail;
    const error = (body as Record<string, unknown>).error;
    const message = (body as Record<string, unknown>).message;
    const title = (body as Record<string, unknown>).title;
    if (detail !== undefined) parts.push(stringify(detail));
    else if (error !== undefined) parts.push(stringify(error));
    else if (message !== undefined) parts.push(stringify(message));
    else if (title !== undefined) parts.push(stringify(title));
    else parts.push(stringify(body));
  }

  const response = err.response as
    | { data?: unknown; statusText?: string }
    | undefined;
  if (response) {
    if (response.data !== undefined && parts.length <= 1) {
      parts.push(stringify(response.data));
    }
    if (response.statusText) parts.push(response.statusText);
  }

  if (parts.length === 0 && err.message) parts.push(String(err.message));
  if (parts.length === 0 && err.cause) parts.push(stringify(err.cause));
  if (parts.length === 0) parts.push(String(e));

  return parts.join(" — ");
}

/** For fire-and-forget promises: log the failure at debug level instead of
 *  dropping it on the floor. Usage: `p.catch(swallow("history append"))`. */
export function swallow(scope: string): (e: unknown) => void {
  return (e) => console.debug(`[swallowed] ${scope}:`, e);
}
