/**
 * Dependency-injection tokens. Explicit tokens (rather than type-based injection) keep the API
 * independent of decorator-metadata emit, so the same code runs under tsc, tsx and the test runner.
 */
export const API_CONFIG = Symbol('API_CONFIG');
export const DB_POOL = Symbol('DB_POOL');
export const LOGGER = Symbol('LOGGER');
