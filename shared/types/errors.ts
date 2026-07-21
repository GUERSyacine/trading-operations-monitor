export type ErrorCode =
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'INVALID_TOKEN'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'SERVER_ERROR'
    | 'UNPROCESSABLE_ENTITY'
    | 'VERSION_REJECTED'
    | 'CAPABILITY_REJECTED';

export interface ErrorResponse {
    success: false;
    error: {
        code: ErrorCode;
        message: string;
        details?: Record<string, unknown>;
    };
    // Legacy support fields to maintain backward compatibility
    status?: string;
    message?: string;
}
