export type ChatPromptInput = {
  userId: string;
  n: number;
  userPromptText: string;
  promptTemplateName?: string;
};

export class ChatPromptError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ChatPromptError';
  }
}