export class HttpError extends Error {
  constructor(status, code, message, { retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
