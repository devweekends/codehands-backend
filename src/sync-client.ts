export type RecordKind = "project" | "session" | "event" | "memory" | "preference";

export interface SyncChange {
  kind: RecordKind;
  id: string;
  version: number;
  deleted?: boolean;
  data: Record<string, unknown>;
}
export interface PushResult {
  accepted: string[];
  rejected: { id: string; reason: string }[];
}
export interface PullResult {
  changes: SyncChange[];
  nextCursor: string;
  hasMore: boolean;
}

// 401: the token is missing or revoked. Retrying will not help.
export class SyncAuthError extends Error {}

export class SyncRequestError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
  }
}

export interface SyncClientOptions {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
}

const BATCH = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSyncClient(opts: SyncClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const delay = opts.retryDelayMs ?? 500;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f(opts.baseUrl + path, {
          ...init,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await opts.getToken()}`,
          },
        });
        if (res.status === 401) throw new SyncAuthError("token missing or revoked");
        if (res.status >= 500) {
          throw new SyncRequestError(`server error ${res.status}`, res.status, true);
        }
        if (!res.ok) {
          throw new SyncRequestError(`request failed ${res.status}`, res.status, false);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof SyncAuthError) throw err;
        if (err instanceof SyncRequestError && !err.retryable) throw err;
        if (attempt >= retries) throw err;
        await sleep(delay * 2 ** attempt);
      }
    }
  }

  // Safe to retry: the server ignores a resend of the same record and version
  async function push(changes: SyncChange[]): Promise<PushResult> {
    const total: PushResult = { accepted: [], rejected: [] };
    for (let i = 0; i < changes.length; i += BATCH) {
      const r = await request<PushResult>("/sync/push", {
        method: "POST",
        body: JSON.stringify({ changes: changes.slice(i, i + BATCH) }),
      });
      total.accepted.push(...r.accepted);
      total.rejected.push(...r.rejected);
    }
    return total;
  }

  async function pull(cursor: string | null): Promise<PullResult> {
    return request<PullResult>(`/sync/pull?cursor=${encodeURIComponent(cursor || "0")}`);
  }

  // Follows hasMore until everything is fetched. Never writes anything itself.
  async function pullAll(cursor: string | null) {
    const changes: SyncChange[] = [];
    let next = cursor || "0";
    for (;;) {
      const page = await pull(next);
      changes.push(...page.changes);
      next = page.nextCursor;
      if (!page.hasMore) return { changes, nextCursor: next };
    }
  }

  return { push, pull, pullAll };
}