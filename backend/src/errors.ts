/**
 * An expected failure with a stable code. Clients translate the code, so no user-facing text or
 * internal detail ever leaves the API.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export const notFound = (code = 'not_found') => new ApiError(404, code);
export const conflict = (code: string) => new ApiError(409, code);
export const badRequest = (code: string) => new ApiError(400, code);
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
