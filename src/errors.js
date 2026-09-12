export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.authRequired = options.authRequired ?? false;
    this.unsafeWrite = options.unsafeWrite ?? false;
    this.service = options.service;
  }
}

export function attributeService(error, service) {
  if (error && typeof error === 'object' && error.service === undefined) error.service = service;
  return error;
}

export function failureScope(error) {
  if (!(error instanceof AppError)) return 'process';
  if (error.service === 'tidal' && (error.authRequired || error.status === 429)) return 'account';
  return 'channel';
}

export function runErrorPrecedence(error) {
  if (failureScope(error) === 'process') return 4;
  if (failureScope(error) === 'account') return 3;
  if (error.unsafeWrite) return 2;
  return 1;
}

export function preferRunError(current, candidate) {
  if (!current || runErrorPrecedence(candidate) > runErrorPrecedence(current)) return candidate;
  return current;
}

export function publicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected local error occurred.' };
}
