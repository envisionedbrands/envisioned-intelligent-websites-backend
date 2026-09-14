'use client';

/**
 * One response contract for the Studio UI.
 *
 * Cloudflare platform failures are HTML pages, not application JSON. Reading
 * every response through this helper prevents those pages from surfacing as
 * `Unexpected token '<'` and gives an expired static workspace a clean path
 * back to the Digital Home login.
 */
export class StudioRequestError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'StudioRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

const platformMessage = (status: number, body: string) => {
  if (/error\s*1102|worker exceeded resource limits|exceeded cpu|exceeded memory/i.test(body)) {
    return 'The Studio service ran out of processing headroom. Nothing was lost — wait a moment and try again.';
  }
  if (status >= 500) {
    return 'The Studio service is temporarily unavailable. Nothing was lost — wait a moment and try again.';
  }
  return `The Studio returned an unexpected response (${status || 'network error'}). Please try again.`;
};

type SessionRecovery = 'recovered' | 'expired' | 'temporary';

let sessionRefresh: Promise<SessionRecovery> | null = null;
let redirectingToLogin = false;

const refreshBrowserSession = async (): Promise<SessionRecovery> => {
  if (typeof window === 'undefined') return 'expired';
  if (sessionRefresh) return sessionRefresh;

  sessionRefresh = (async () => {
    try {
      const { createClient: createBrowserClient } = await import('@/lib/supabase/browser');
      const supabase = createBrowserClient();
      const { data, error } = await supabase.auth.refreshSession();
      if (data.session && !error) return 'recovered';

      const status = Number((error as { status?: number } | null)?.status ?? 0);
      // A network/provider fault must not be presented as a logout. The
      // caller keeps its local recovery snapshot and can retry in place.
      if (error && (status === 0 || status === 408 || status === 429 || status >= 500)) return 'temporary';
      return 'expired';
    } catch {
      return 'temporary';
    } finally {
      sessionRefresh = null;
    }
  })();

  return sessionRefresh;
};

const redirectToLogin = () => {
  if (typeof window === 'undefined' || redirectingToLogin) return;
  redirectingToLogin = true;
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
};

const requestHasMachineAuthorization = (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return headers.has('authorization');
};

const fetchOnce = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input.clone() : input;
  // Cloudflare augments the global Request generics. The browser-compatible
  // runtime value is unchanged; this cast only reconciles those overloads.
  return fetch(request as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
};

/**
 * Fetch a Studio response and repair one stale browser session before the UI
 * sees a 401. Concurrent calls share one refresh, which avoids a refresh-token
 * stampede when autosave, polling, and a desk request meet at token expiry.
 */
export async function studioFetchResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetchOnce(input, init);
  } catch {
    throw new StudioRequestError('The Studio could not reach your Digital Home. Check your connection and try again.', 0, true);
  }

  if (response.status !== 401 || typeof window === 'undefined' || requestHasMachineAuthorization(input, init)) {
    return response;
  }

  const recovery = await refreshBrowserSession();
  if (recovery === 'temporary') {
    throw new StudioRequestError(
      'The Studio could not confirm your session just now. Your board is safe here — wait a moment and retry.',
      0,
      true,
    );
  }
  if (recovery === 'expired') return response;

  try {
    return await fetchOnce(input, init);
  } catch {
    throw new StudioRequestError('Your session was refreshed, but the Studio could not retry the request. Please try again.', 0, true);
  }
}

export async function studioResponseError(response: Response): Promise<StudioRequestError> {
  const body = await response.text().catch(() => '');
  const contentType = response.headers.get('content-type') ?? '';
  let message = '';

  if (/application\/(?:problem\+)?json/i.test(contentType) || /^[\s\n]*[\[{]/.test(body)) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
      else if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // A proxy can label a truncated response as JSON. Use the safe platform
      // message below instead of exposing the parser error to the member.
    }
  }

  if (response.status === 401) {
    redirectToLogin();
    return new StudioRequestError('Your Digital Home session expired. Reopening sign in…', 401, false);
  }

  return new StudioRequestError(
    message || platformMessage(response.status, body),
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
  );
}

export async function studioFetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await studioFetchResponse(input, init);

  if (!response.ok) throw await studioResponseError(response);

  const body = await response.text();
  if (!body.trim()) return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new StudioRequestError(platformMessage(response.status, body), response.status, true);
  }
}

export async function studioFetchOk(input: RequestInfo | URL, init?: RequestInit): Promise<void> {
  const response = await studioFetchResponse(input, init);
  if (!response.ok) throw await studioResponseError(response);
}

export const studioErrorMessage = (error: unknown, fallback = 'The Studio could not finish that action. Please try again.') =>
  error instanceof Error && error.message ? error.message : fallback;
