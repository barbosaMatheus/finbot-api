export type AuthUser = {
  id: string;
  email: string;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type AuthResult = {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeMs: number;
};
