export class UnrecoverableJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableJobError";
  }
}

export class QueueUnavailableError extends Error {
  constructor(message = "Redis queue is unavailable.") {
    super(message);
    this.name = "QueueUnavailableError";
  }
}
