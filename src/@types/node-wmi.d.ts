/**
 * Hand-written type declarations for the untyped `node-wmi` npm package.
 * Based on the package's README and source (v0.0.5).
 */
declare module 'node-wmi' {
  export type WmiRow = Record<string, unknown>;
  export type WmiCallback = (err: Error | null, result: WmiRow[]) => void;

  export interface QueryOptions {
    /** WMI class to query (required) */
    class: string;
    /** Remote hostname or IP; defaults to localhost */
    host?: string;
    /** WMI namespace; defaults to root\CIMV2 */
    namespace?: string;
    /** Username for remote authentication (domain\\user format) */
    username?: string;
    /** Password for remote authentication */
    password?: string;
    /** Subset of properties to retrieve; omit for all */
    properties?: string[];
    /** WQL WHERE condition(s); string or array joined with AND */
    where?: string | string[];
  }

  export interface QueryChain {
    host(host: string): QueryChain;
    namespace(ns: string): QueryChain;
    class(className: string, callback?: WmiCallback): QueryChain;
    username(user: string): QueryChain;
    password(pass: string): QueryChain;
    properties(props: string[]): QueryChain;
    where(condition: string | string[]): QueryChain;
    exec(callback: WmiCallback): void;
  }

  /** Start a chainable query builder */
  export function Query(): QueryChain;
  /** Execute a one-shot query with an options object */
  export function Query(opts: QueryOptions, callback: WmiCallback): void;
}
