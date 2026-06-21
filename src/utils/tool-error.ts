export type ToolErrorCode =
  | "COMMAND_VALIDATION_FAILED"
  | "COMMAND_EXECUTION_ERROR"
  | "COMMAND_TIMEOUT"
  | "SSH_CONNECTION_FAILED"
  | "SSH_CONNECTION_TIMEOUT"
  | "SSH_EXECUTION_FAILED"
  | "SSH_AUTHENTICATION_MISSING"
  | "SERVER_NOT_FOUND"
  | "SERVER_ACCESS_DENIED"
  | "INSUFFICIENT_SCOPE"
  | "TOO_MANY_CONNECTIONS"
  | "LOCAL_PATH_NOT_ALLOWED"
  | "REMOTE_PATH_NOT_ALLOWED"
  | "LOCAL_FILE_READ_FAILED"
  | "LOCAL_FILE_WRITE_FAILED"
  | "OPERATION_TIMEOUT"
  | "SFTP_ERROR"
  | "UNSUPPORTED_IN_SHELL_MODE"
  | "UNAUTHORIZED"
  | "UNKNOWN_ERROR";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function toToolError(
  error: unknown,
  fallbackCode: ToolErrorCode,
): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  if (error instanceof Error) {
    return new ToolError(fallbackCode, error.message, false);
  }

  return new ToolError(fallbackCode, String(error), false);
}
