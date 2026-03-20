import { ApiSuccess, ApiFailure, ApiMeta } from '../types/api.types';

export function successResponse<T>(
  data: T,
  message: string,
  meta: ApiMeta,
): ApiSuccess<T> {
  return { success: true, message, data, meta };
}

export function failureResponse(
  code: string,
  message: string,
  meta: ApiMeta,
  details?: Record<string, unknown>,
): ApiFailure {
  return {
    success: false,
    message,
    error: { code, message, ...(details ? { details } : {}) },
    meta,
  };
}

export function buildMeta(requestId: string, startTime: number): ApiMeta {
  return {
    timestamp: new Date().toISOString(),
    requestId,
    duration: Date.now() - startTime,
  };
}
