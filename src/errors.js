export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.authRequired = options.authRequired ?? false;
    this.unsafeWrite = options.unsafeWrite ?? false;
  }
}

export function publicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected local error occurred.' };
}
