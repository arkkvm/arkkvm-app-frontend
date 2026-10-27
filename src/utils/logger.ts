/**
 * Unified logging system.
 * Provides unified logging interface with environment control and log level management.
 */

import { isDevelopment, isProduction } from './version';
import { redactLog } from './redactLog';
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

interface LoggerConfig {
  level: LogLevel
  enableConsole: boolean
  enableTimestamp: boolean
  enableModuleName: boolean
  productionLevel: LogLevel
}

const defaultConfig: LoggerConfig = {
  level: isDevelopment() ? LogLevel.DEBUG : LogLevel.NONE,
  enableConsole: !isProduction(),
  enableTimestamp: true,
  enableModuleName: true,
  productionLevel: LogLevel.NONE,
};

let loggerConfig: LoggerConfig = { ...defaultConfig };
const levelColors = {
  [LogLevel.DEBUG]: '#6B7280',
  [LogLevel.INFO]: '#3B82F6',
  [LogLevel.WARN]: '#F59E0B',
  [LogLevel.ERROR]: '#EF4444',
};
const levelNames = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

/**
 * Format timestamp.
 */
function formatTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

/**
 * Create log prefix.
 */
function createPrefix(level: LogLevel, moduleName?: string): string {
  const parts: string[] = [];

  if (loggerConfig.enableTimestamp) {
    parts.push(`[${formatTimestamp()}]`);
  }

  parts.push(`[${levelNames[level]}]`);

  if (loggerConfig.enableModuleName && moduleName) {
    parts.push(`[${redactLog(moduleName)}]`);
  }

  return parts.join(' ');
}

/**
 * Check if log should be output.
 */
function shouldLog(level: LogLevel): boolean {
  if (!loggerConfig.enableConsole) return false;

  const currentLevel = isProduction()
    ? loggerConfig.productionLevel
    : loggerConfig.level;

  return level >= currentLevel;
}

/**
 * Core log output function.
 */
function logWithLevel(
  level: LogLevel,
  moduleName: string | undefined,
  message: unknown,
  ...args: unknown[]
) {
  if (!shouldLog(level)) return;

  const prefix = createPrefix(level, moduleName);
  const color = levelColors[level];
  const payload = redactLog([message, ...args]) as unknown[];

  const consoleMethod =
    {
      [LogLevel.DEBUG]: console.debug,
      [LogLevel.INFO]: console.info,
      [LogLevel.WARN]: console.warn,
      [LogLevel.ERROR]: console.error,
    }[level] || console.log;

  if (typeof window !== 'undefined') {
    consoleMethod(
      `%c${prefix}`,
      `color: ${color}; font-weight: bold;`,
      ...payload
    );
  } else {
    consoleMethod(prefix, ...payload);
  }
}

/**
 * Create module logger.
 */
export function createLogger(moduleName?: string) {
  return {
    debug: (message: unknown, ...args: unknown[]) =>
      logWithLevel(LogLevel.DEBUG, moduleName, message, ...args),

    info: (message: unknown, ...args: unknown[]) =>
      logWithLevel(LogLevel.INFO, moduleName, message, ...args),

    warn: (message: unknown, ...args: unknown[]) =>
      logWithLevel(LogLevel.WARN, moduleName, message, ...args),

    error: (message: unknown, ...args: unknown[]) =>
      logWithLevel(LogLevel.ERROR, moduleName, message, ...args),

    group: (label: string) => {
      if (shouldLog(LogLevel.INFO)) {
        console.group(`${createPrefix(LogLevel.INFO, moduleName)} ${redactLog(label)}`);
      }
    },

    groupEnd: () => {
      if (shouldLog(LogLevel.INFO)) {
        console.groupEnd();
      }
    },

    table: (data: unknown) => {
      if (shouldLog(LogLevel.DEBUG)) {
        console.table(redactLog(data));
      }
    },

    time: (label: string) => {
      if (shouldLog(LogLevel.DEBUG)) {
        console.time(`${moduleName ? `[${redactLog(moduleName)}] ` : ''}${redactLog(label)}`);
      }
    },

    timeEnd: (label: string) => {
      if (shouldLog(LogLevel.DEBUG)) {
        console.timeEnd(`${moduleName ? `[${redactLog(moduleName)}] ` : ''}${redactLog(label)}`);
      }
    },
  };
}

/**
 * Default logger (no module name).
 */
export const logger = createLogger();

/**
 * Configure logger.
 */
export function configureLogger(config: Partial<LoggerConfig>) {
  loggerConfig = { ...loggerConfig, ...config };
}

/**
 * Get current logger configuration.
 */
export function getLoggerConfig(): LoggerConfig {
  return { ...loggerConfig };
}

/**
 * Reset logger configuration to default.
 */
export function resetLoggerConfig() {
  loggerConfig = { ...defaultConfig };
}

/**
 * Conditional log - output only when condition is true.
 */
export function logIf(
  condition: boolean,
  level: LogLevel,
  message: unknown,
  ...args: unknown[]
) {
  if (condition) {
    logWithLevel(level, undefined, message, ...args);
  }
}

/**
 * Performance log - measure function execution time.
 */
export function logPerformance<T>(
  label: string,
  fn: () => T,
  moduleName?: string
): T {
  const perfLogger = createLogger(moduleName);
  perfLogger.time(label);
  try {
    const result = fn();
    perfLogger.timeEnd(label);
    return result;
  } catch (error) {
    perfLogger.timeEnd(label);
    perfLogger.error(`${label} execution failed:`, error);
    throw error;
  }
}

/**
 * Async performance log.
 */
export async function logAsyncPerformance<T>(
  label: string,
  fn: () => Promise<T>,
  moduleName?: string
): Promise<T> {
  const perfLogger = createLogger(moduleName);
  perfLogger.time(label);
  try {
    const result = await fn();
    perfLogger.timeEnd(label);
    return result;
  } catch (error) {
    perfLogger.timeEnd(label);
    perfLogger.error(`${label} execution failed:`, error);
    throw error;
  }
}
export const componentLogger = createLogger('Component');
export const apiLogger = createLogger('API');
export const routerLogger = createLogger('Router');
export const storeLogger = createLogger('Store');
export const hookLogger = createLogger('Hook');
export const utilLogger = createLogger('Util');

if (isDevelopment()) {
  logger.info('🚀 Logger system initialized', {
    config: loggerConfig,
    environment: process.env.NODE_ENV,
    buildTarget: process.env.BUILD_TARGET,
  });
}
