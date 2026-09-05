/**
 * Gameplan domain errors, mapped to HTTP by the route the same way
 * OnboardingError is: statusCode and a stable code the client can branch on.
 */

export class GameplanError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'GameplanError';
  }
}
