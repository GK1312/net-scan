export interface ApiMeta {
  timestamp: string;
  requestId: string;
  duration: number;
}

export interface ApiSuccess<T = unknown> {
  success: true;
  message: string;
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  message: string;
  error: ApiErrorBody;
  meta: ApiMeta;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;
