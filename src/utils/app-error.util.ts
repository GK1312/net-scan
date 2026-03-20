export const ErrorCode = {
  VALIDATION_ERROR:    'VALIDATION_ERROR',
  PING_FAILED:         'PING_FAILED',
  CONNECTION_FAILED:   'CONNECTION_FAILED',
  PS_EXECUTION_FAILED: 'PS_EXECUTION_FAILED',
  PS_TIMEOUT:          'PS_TIMEOUT',
  PARSE_ERROR:         'PARSE_ERROR',
  UNKNOWN_METHOD:      'UNKNOWN_METHOD',
  NOT_FOUND:           'NOT_FOUND',
  INTERNAL_ERROR:      'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCodeValue | string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
