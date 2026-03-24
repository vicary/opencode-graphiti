import { redactEndpointUserInfo } from "../src/services/endpoint-redaction.ts";

export const formatEndpointForDisplay = (endpoint: string): string =>
  redactEndpointUserInfo(endpoint);
