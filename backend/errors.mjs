export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new ApiError(400, "ERR_BAD_REQUEST", message, details);
}

export function unauthorized(message = "You must be signed in to continue") {
  return new ApiError(401, "ERR_UNAUTHENTICATED", message);
}

export function forbidden(message = "You do not have permission to perform this action") {
  return new ApiError(403, "ERR_FORBIDDEN", message);
}

export function notFound(message = "Resource not found") {
  return new ApiError(404, "ERR_NOT_FOUND", message);
}

export function sendError(res, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const body = {
    code: error instanceof ApiError ? error.code : "ERR_INTERNAL",
    message: error instanceof Error ? error.message : "Internal server error",
  };
  if (error instanceof ApiError && error.details !== undefined) body.details = error.details;
  if (status >= 500) console.error(error);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

