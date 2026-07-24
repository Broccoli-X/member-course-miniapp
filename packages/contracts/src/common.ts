export interface ApiEnvelope<T = unknown> {
  code: string;
  message: string;
  traceId: string;
  data?: T;
  details?: Record<string, unknown>;
}
