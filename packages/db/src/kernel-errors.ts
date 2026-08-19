export class IdentifierCollisionError extends Error {
  readonly permanent = true;
  constructor() {
    super("Identifier is already bound to a different entity.");
    this.name = "IdentifierCollisionError";
  }
}

export class ImmutableHistoryError extends Error {
  constructor() {
    super("Analytical history is immutable.");
    this.name = "ImmutableHistoryError";
  }
}

export class IllegalDecisionTransitionError extends Error {
  constructor() {
    super("Illegal decision record transition.");
    this.name = "IllegalDecisionTransitionError";
  }
}

export class UnknownEventTypeError extends Error {
  readonly permanent = true;
  constructor(eventType: string) {
    super(`Unknown event type: ${eventType}`);
    this.name = "UnknownEventTypeError";
  }
}

export class InvalidMetricError extends Error {
  readonly permanent = true;
  constructor(message = "Invalid observation metric.") {
    super(message);
    this.name = "InvalidMetricError";
  }
}

export class InvalidConfidenceError extends Error {
  readonly permanent = true;
  constructor(message = "Confidence must be between 0 and 1.") {
    super(message);
    this.name = "InvalidConfidenceError";
  }
}

export class KernelValidationError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "KernelValidationError";
  }
}

export class MissingSignalEvidenceError extends Error {
  readonly permanent = true;
  constructor() {
    super("Signals require at least one evidence reference.");
    this.name = "MissingSignalEvidenceError";
  }
}
