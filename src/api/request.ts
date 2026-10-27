/**
 * Lightweight fetch API wrapper with timeout, authentication, and error handling.
 */

import { normalizeUrl } from '@/utils/common';
import { env } from '@/utils/env';
import { createLogger } from '@/utils/logger';
import { captureCsrfRequest, isCurrentCsrfRequest, updateCsrfToken, type CsrfRequestContext } from './csrfSession';

const logger = createLogger('API');

const getBaseURL = (): string => {
  return env.apiBaseUrl as string;
};
export interface RequestConfig extends RequestInit {
  params?: Record<string, string | number | boolean>
  timeout?: number
  /** Explicit API origin: isolate credentials and auth side effects from the current app. */
  baseURL?: string
}

export interface ApiResponse<T = unknown> {
  code: number
  data: T
  message: string
  success: boolean
}

const buildRequestUrl = (url: string, config: RequestConfig = {}) => {
  const { params, baseURL: _baseURL, ...restConfig } = config;
  let finalUrl = url;

  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });
    finalUrl += (url.includes('?') ? '&' : '?') + searchParams.toString();
  }

  return { finalUrl, config: restConfig };
};

export const buildRequestHeaders = (config: RequestConfig, isolated = false) => {
  const headers = new Headers(config.headers);
  if (env.target !== 'cloud') {
    headers.set('Accept', 'application/json');
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const token = isolated ? null : localStorage.getItem('token');
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const csrfToken = isolated ? null : sessionStorage.getItem('csrfToken');
  if (csrfToken && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  return { ...config, ...(isolated ? { credentials: 'omit' as const } : {}), headers };
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  if (!ms) return promise;

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Request timeout: ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]);
};

function extractCsrfToken(response: Response, context?: CsrfRequestContext): void {
  const csrfToken = response.headers.get('X-CSRF-Token') ||
                    response.headers.get('x-csrf-token') ||
                    response.headers.get('X-CSRF-Token');

  if (csrfToken) {
    if (context) updateCsrfToken(csrfToken, context);
    else sessionStorage.setItem('csrfToken', csrfToken);
    logger.debug('CSRF Token saved to sessionStorage');
  } else {
    logger.debug('No CSRF Token found in response headers');
  }
}

async function parseErrorResponse(response: Response): Promise<{ data: unknown; message: string }> {
  let errorData: Record<string, unknown> | null = null;
  let errorMessage = `HTTP error: ${response.status} ${response.statusText}`;

  try {
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      errorData = await response.json() as Record<string, unknown>;
      if (typeof errorData?.message === 'string') {
        errorMessage = errorData.message;
      } else if (errorData?.error && typeof (errorData.error as Record<string, unknown>).brief === 'string') {
        errorMessage = (errorData.error as Record<string, unknown>).brief as string;
      }
    } else {
      await response.text();
    }
  } catch {
    // ignore parse errors, keep default errorMessage
  }

  logger.error('HTTP request failed', { status: response.status });
  return { data: errorData, message: errorMessage };
}

function handleUnauthorized(_response: Response, errorData: unknown, errorMessage: string): ApiResponse<unknown> | null {
  const isOnLoginPage = window.location.pathname === '/login' || window.location.pathname === '/login-local';

  if (isOnLoginPage) {
    const result = {
      code: 401,
      success: false,
      data: '' as unknown,
      message: errorMessage,
    };
    logger.debug('[401] on login page, returning failure');
    return result;
  }

  localStorage.removeItem('token');
  sessionStorage.removeItem('csrfToken');
  const isCloudAccess = env.target === 'cloud';
  logger.debug('Unauthorized access detected, redirecting...', { isCloudAccess });

  if (isCloudAccess) {
    window.location.href = '/login';
  } else {
    window.location.href = '/login-local';
  }

  logger.warn('Unauthorized, please login again');
  return null;
}

function handleForbidden(_response: Response): void {
  const localAuthMode = localStorage.getItem('localAuthMode');
  const isCloudAccess = env.target === 'cloud';
  const isOnLoginPage = window.location.pathname === '/login' || window.location.pathname === '/login-local';

  logger.debug('Forbidden access detected', { localAuthMode, isCloudAccess });
  if (!isCloudAccess && localAuthMode === 'password' && !isOnLoginPage) {
    localStorage.removeItem('token');
    sessionStorage.removeItem('csrfToken');
    // window.location.href = '/login-local';
    logger.warn('Forbidden, redirecting to login page');
  }
}

async function handleSuccessResponse<T>(response: Response, isolated = false, context?: CsrfRequestContext): Promise<ApiResponse<T>> {
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    const data = await response.json();
    if (!isolated && data && data.csrfToken) {
      // Device response headers are paired with the browser's Set-Cookie.
      // A delayed body must never overwrite a newer session or its header.
      if (context) {
        if (!response.headers.get('X-CSRF-Token')) updateCsrfToken(data.csrfToken, context);
      } else sessionStorage.setItem('csrfToken', data.csrfToken);
      logger.debug('CSRF Token saved from response body');
    }

    if (data && data.code !== undefined && !data.success && data.code !== 200) {
      logger.error('API business error', { code: data.code });
      return {
        code: data.code,
        success: false,
        data: data.data ?? ('' as unknown as T),
        message: data.message || 'Business logic failed',
      };
    }

    if (data && typeof data === 'object' && 'success' in data && 'code' in data) {
      return data as ApiResponse<T>;
    }
    return {
      code: 200,
      success: true,
      data: data as T,
      message: 'Success',
    };
  } else {
    const text = await response.text();
    return {
      code: 200,
      success: true,
      data: text as unknown as T,
      message: 'Success',
    };
  }
}

async function handleResponse<T>(response: Response, isolated = false, context?: CsrfRequestContext): Promise<ApiResponse<T>> {
  const isCurrent = () => !context || isCurrentCsrfRequest(context);
  if (!isolated && isCurrent()) extractCsrfToken(response, context);

  if (!response.ok) {
    const { data: errorData, message: errorMessage } = await parseErrorResponse(response);

    if (response.status === 400) {
      logger.warn('Bad Request (400)');
    }

    if (!isolated && isCurrent() && response.status === 401) {
      const result = handleUnauthorized(response, errorData, errorMessage);
      if (result) return result as ApiResponse<T>;
    }

    if (!isolated && isCurrent() && response.status === 403) {
      handleForbidden(response);
    }

    const errorResult = {
      code: response.status,
      success: false,
      data: '' as unknown as T,
      message: errorMessage,
    };
    logger.debug(`HTTP ${response.status}`);
    return errorResult;
  }

  const result = await handleSuccessResponse<T>(response, isolated, context);
  logger.debug(`HTTP ${response.status}`);
  return result;
}

function safeRequest<T>(promise: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  return promise.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Request failed');
    return {
      code: 0,
      success: false,
      data: '' as unknown as T,
      message,
    };
  });
}

function responseHandler<T>(url: string, headers: Headers, isolated: boolean) {
  const context = !isolated && env.target === 'device'
    ? captureCsrfRequest(headers.get('X-CSRF-Token'),
        /^\/(?:auth\/(?:login-local|logout|password-local|local-password)|device\/setup)(?:[?#]|$)/.test(url))
    : undefined;
  return (response: Response) => handleResponse<T>(response, isolated, context);
}

export const request = {
  /**
   * Perform GET request
   */
  get: async <T = unknown>(
    url: string,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> => {
    const { finalUrl, config: finalConfig } = buildRequestUrl(url, config);
    const configWithHeaders = buildRequestHeaders(finalConfig, config?.baseURL !== undefined);

    const fetchPromise = fetch(normalizeUrl((config?.baseURL ?? getBaseURL()) + finalUrl), {
      ...configWithHeaders,
      mode: 'cors',
      method: 'GET',
    }).then(responseHandler<T>(url, configWithHeaders.headers, config?.baseURL !== undefined));

    return safeRequest(withTimeout(fetchPromise, config?.timeout || 60000));
  },

  /**
   * Perform POST request
   */
  post: async <T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> => {
    const { finalUrl, config: finalConfig } = buildRequestUrl(url, config);
    const configWithHeaders = buildRequestHeaders(finalConfig, config?.baseURL !== undefined);

    const fetchPromise = fetch(normalizeUrl((config?.baseURL ?? getBaseURL()) + finalUrl), {
      ...configWithHeaders,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }).then(responseHandler<T>(url, configWithHeaders.headers, config?.baseURL !== undefined));

    return safeRequest(withTimeout(fetchPromise, config?.timeout || 60000));
  },

  /**
   * Perform PUT request
   */
  put: async <T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> => {
    const { finalUrl, config: finalConfig } = buildRequestUrl(url, config);
    const configWithHeaders = buildRequestHeaders(finalConfig, config?.baseURL !== undefined);

    const fetchPromise = fetch(normalizeUrl((config?.baseURL ?? getBaseURL()) + finalUrl), {
      ...configWithHeaders,
      method: 'PUT',
      mode: 'cors',
      body: data ? JSON.stringify(data) : undefined,
    }).then(responseHandler<T>(url, configWithHeaders.headers, config?.baseURL !== undefined));

    return safeRequest(withTimeout(fetchPromise, config?.timeout || 60000));
  },

  /**
   * Perform DELETE request
   */
  delete: async <T = unknown>(
    url: string,
    config?: RequestConfig,
    data?: unknown
  ): Promise<ApiResponse<T>> => {
    const { finalUrl, config: finalConfig } = buildRequestUrl(url, config);
    const configWithHeaders = buildRequestHeaders(finalConfig, config?.baseURL !== undefined);

    const fetchPromise = fetch(normalizeUrl((config?.baseURL ?? getBaseURL()) + finalUrl), {
      ...configWithHeaders,
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    }).then(responseHandler<T>(url, configWithHeaders.headers, config?.baseURL !== undefined));

    return safeRequest(withTimeout(fetchPromise, config?.timeout || 60000));
  },

  /**
   * Perform PATCH request
   */
  patch: async <T = unknown>(
    url: string,
    data?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> => {
    const { finalUrl, config: finalConfig } = buildRequestUrl(url, config);
    const configWithHeaders = buildRequestHeaders(finalConfig, config?.baseURL !== undefined);

    const fetchPromise = fetch(normalizeUrl((config?.baseURL ?? getBaseURL()) + finalUrl), {
      ...configWithHeaders,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }).then(responseHandler<T>(url, configWithHeaders.headers, config?.baseURL !== undefined));

    return safeRequest(withTimeout(fetchPromise, config?.timeout || 60000));
  },
};

export default request;
