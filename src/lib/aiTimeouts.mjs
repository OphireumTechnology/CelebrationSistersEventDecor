export const MAX_GEMINI_TIMEOUT_MS = 90_000;

// Allow time for authentication, persistence, and the response after generation.
export const AI_RESPONSE_TIMEOUT_MS = MAX_GEMINI_TIMEOUT_MS + 15_000;
