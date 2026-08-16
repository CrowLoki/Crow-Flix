/**
 * Error carrying an HTTP status so the Worker entry can map thrown failures
 * to JSON error responses without guessing.
 */
export class RelayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
  }
}
