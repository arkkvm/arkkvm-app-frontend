import { request, type ApiResponse } from './request';

/** GET /ip: a missing location is null, never an inferred overseas result. */
export interface IPLocation {
  ip: string;
  isPublic: boolean;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

export function getIPLocation(signal?: AbortSignal): Promise<ApiResponse<IPLocation>> {
  return request.get<IPLocation>('/ip', { signal, timeout: 3000, cache: 'no-store' });
}
