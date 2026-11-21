import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const STAGING_EXTERNAL_PROJECT_REF = 'nswxwwmtcasmkjtmrdqg';
export const STAGING_EXTERNAL_ADMIN_UUID = 'fd9523dd-eb07-4cca-9040-62feea3f5353';

const PENDING_FACTOR_STORAGE_KEY = 'cs_pending_ext_totp_factor_v1';
const PENDING_FACTOR_TTL_MS = 15 * 60 * 1000;

export interface PendingFactorRecord {
  factorId: string;
  userId: string;
  createdAt: number;
}

export interface ExternalMfaFactorSummary {
  id: string;
  factor_type?: string;
  status?: string;
  friendly_name?: string;
}

export interface ExternalStagingSupabaseClientLike {
  auth: {
    getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
    getSession: () => Promise<{
      data: { session: { access_token: string; user?: { id: string } | null } | null };
      error?: unknown;
    }>;
    refreshSession?: () => Promise<{
      data: { session: { access_token: string; user?: { id: string } | null } | null };
      error?: unknown;
    }>;
    signOut: () => Promise<{ error?: unknown }>;
    mfa: {
      listFactors: () => Promise<{
        data: { totp: ExternalMfaFactorSummary[]; all?: ExternalMfaFactorSummary[] } | null;
        error: unknown;
      }>;
      enroll: (params: { factorType: 'totp'; friendlyName?: string }) => Promise<{
        data: {
          id: string;
          totp: { qr_code: string; secret: string; uri: string };
        } | null;
        error: unknown;
      }>;
      unenroll?: (params: { factorId: string }) => Promise<{ data?: unknown; error: unknown }>;
      challengeAndVerify: (params: { factorId: string; code: string }) => Promise<{
        data: unknown;
        error: unknown;
      }>;
      getAuthenticatorAssuranceLevel: () => Promise<{
        data: { currentLevel: string | null; nextLevel?: string | null } | null;
        error: unknown;
      }>;
    };
  };
}

let client: SupabaseClient | null = null;
let providerAdminClient: SupabaseClient | null = null;
let pendingTotpFactor: PendingFactorRecord | null = null;

function readPendingFactorFromStorage(): PendingFactorRecord | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_FACTOR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingFactorRecord>;
    if (
      typeof parsed.factorId !== 'string' ||
      !parsed.factorId.trim() ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      window.sessionStorage.removeItem(PENDING_FACTOR_STORAGE_KEY);
      return null;
    }
    if (Date.now() - parsed.createdAt > PENDING_FACTOR_TTL_MS) {
      window.sessionStorage.removeItem(PENDING_FACTOR_STORAGE_KEY);
      return null;
    }
    return {
      factorId: parsed.factorId.trim(),
      userId: parsed.userId,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function writePendingFactorToStorage(record: PendingFactorRecord | null): void {
  pendingTotpFactor = record;
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    if (!record) {
      window.sessionStorage.removeItem(PENDING_FACTOR_STORAGE_KEY);
    } else {
      // Security invariant: NEVER persist TOTP secret, QR code, or otpauth URI in browser storage.
      // Only the non-secret Supabase factor UUID metadata is preserved for reload handoff.
      window.sessionStorage.setItem(PENDING_FACTOR_STORAGE_KEY, JSON.stringify(record));
    }
  } catch {
    // Ignore storage quota or restricted iframe errors; in-memory handoff remains active.
  }
}

export function clearPendingExternalTotpFactor(): void {
  writePendingFactorToStorage(null);
}

/** Explicit opt-in only: browser never receives a service-role key. */
export function getExternalStagingMfaClient(): SupabaseClient | null {
  if (import.meta.env.VITE_PHASE19_EXTERNAL_AUTH_STAGING !== 'true') return null;
  const key = import.meta.env.VITE_PHASE19_EXTERNAL_AUTH_ANON_KEY;
  if (!key) return null;
  if (!client) {
    client = createClient(`https://${STAGING_EXTERNAL_PROJECT_REF}.supabase.co`, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

export function getProviderAdminMfaClient(expectedUrl?: string): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (expectedUrl && url.trim().replace(/\/+$/, '') !== expectedUrl.trim().replace(/\/+$/, '')) return null;
  providerAdminClient ??= createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'celebration-provider-admin',
    },
  });
  return providerAdminClient;
}

export function getPendingExternalTotpFactorId(expectedUserId?: string): string | null {
  const active = pendingTotpFactor ?? readPendingFactorFromStorage();
  if (!active) return null;
  if (Date.now() - active.createdAt > PENDING_FACTOR_TTL_MS) {
    clearPendingExternalTotpFactor();
    return null;
  }
  if (expectedUserId && active.userId !== expectedUserId) {
    clearPendingExternalTotpFactor();
    return null;
  }
  pendingTotpFactor = active;
  return active.factorId;
}

async function assertAuthenticatedAdministrator(
  supabase: ExternalStagingSupabaseClientLike,
  expectedSubject?: string,
): Promise<string> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (userError || !userId) {
    throw new Error('Active Supabase authentication session required. Please sign in again.');
  }
  if (userId !== (expectedSubject ?? STAGING_EXTERNAL_ADMIN_UUID)) {
    clearPendingExternalTotpFactor();
    throw new Error(expectedSubject
      ? 'Authenticated administrator session required.'
      : 'Authenticated staging administrator session required.');
  }
  return userId;
}

/**
 * Resolves the authoritative TOTP factor ID for verification across both immediate
 * enrollment-to-verification handoff and browser reloads (checking verified and unverified factors).
 */
export async function resolveExternalTotpFactorId(
  clientOverride?: ExternalStagingSupabaseClientLike | null,
  expectedSubject?: string,
): Promise<string | null> {
  const supabase = clientOverride !== undefined ? clientOverride : getExternalStagingMfaClient();
  if (!supabase) return null;
  const userId = await assertAuthenticatedAdministrator(supabase, expectedSubject);

  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error || !factors) {
    throw new Error('Unable to inspect authenticator factors for the active session.');
  }

  const allFactors = Array.isArray(factors.all) ? factors.all : [];
  const verifiedTotp = Array.isArray(factors.totp) ? factors.totp : [];
  const unverifiedTotp = allFactors.filter(
    (f) => f.factor_type === 'totp' && f.status === 'unverified',
  );

  // 1. Prefer an active pending factor ID if it still exists (handles immediate handoff + page reload)
  const pendingId = getPendingExternalTotpFactorId(userId);
  if (pendingId) {
    const knownByServer =
      allFactors.length === 0 ||
      allFactors.some((f) => f.id === pendingId) ||
      verifiedTotp.some((f) => f.id === pendingId);
    if (knownByServer) {
      return pendingId;
    }
    clearPendingExternalTotpFactor();
  }

  // 2. Fall back to an existing verified TOTP factor
  if (verifiedTotp[0]?.id) {
    return verifiedTotp[0].id;
  }

  // 3. Fall back to the most recent unverified TOTP factor (handles reload if sessionStorage was cleared)
  if (unverifiedTotp.length > 0) {
    const recoveredId = unverifiedTotp[unverifiedTotp.length - 1].id;
    writePendingFactorToStorage({ factorId: recoveredId, userId, createdAt: Date.now() });
    return recoveredId;
  }

  return null;
}

export async function enrollExternalStagingTotp(options?: {
  replaceUnverified?: boolean;
  clientOverride?: ExternalStagingSupabaseClientLike | null;
  expectedSubject?: string;
}) {
  const supabase =
    options?.clientOverride !== undefined ? options.clientOverride : getExternalStagingMfaClient();
  if (!supabase) throw new Error('Supabase MFA is not configured.');

  const userId = await assertAuthenticatedAdministrator(supabase, options?.expectedSubject);

  const { data: existingFactors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) {
    throw new Error('Unable to inspect existing authenticator factors before enrollment.');
  }

  const verifiedTotp = Array.isArray(existingFactors?.totp) ? existingFactors.totp : [];
  if (verifiedTotp.length > 0) {
    throw new Error(
      'A verified TOTP authenticator is already enrolled on this account. Enter your 6-digit code to complete AAL2 verification.',
    );
  }

  const unverifiedTotp = (Array.isArray(existingFactors?.all) ? existingFactors.all : []).filter(
    (f) => f.factor_type === 'totp' && f.status === 'unverified',
  );

  if (unverifiedTotp.length > 0 && options?.replaceUnverified && supabase.auth.mfa.unenroll) {
    for (const stale of unverifiedTotp) {
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: stale.id });
      if (unenrollErr) {
        throw new Error('Unable to clear previous incomplete authenticator setup.');
      }
    }
    clearPendingExternalTotpFactor();
  }

  const accountLabel = options?.expectedSubject
    ? 'Celebration Sisters administrator'
    : 'Celebration Sisters staging administrator';
  const friendlyName =
    unverifiedTotp.length > 0 && !options?.replaceUnverified
      ? `${accountLabel} ${Date.now().toString(36)}`
      : accountLabel;

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
  });
  if (error || !data?.id || !data.totp?.secret) {
    throw new Error(
      error instanceof Error ? error.message : 'Unable to start Supabase TOTP authenticator enrollment.',
    );
  }

  writePendingFactorToStorage({
    factorId: data.id,
    userId,
    createdAt: Date.now(),
  });

  return {
    factorId: data.id,
    qr: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

export async function verifyExternalStagingTotp(
  factorId: string,
  rawCode: string,
  clientOverride?: ExternalStagingSupabaseClientLike | null,
  expectedSubject?: string,
) {
  const supabase = clientOverride !== undefined ? clientOverride : getExternalStagingMfaClient();
  if (!supabase) throw new Error('Supabase MFA is not configured.');

  const normalizedFactorId = factorId.trim();
  if (!normalizedFactorId) {
    throw new Error('Enroll an authenticator before verifying MFA.');
  }

  const normalizedCode = rawCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error('Enter a valid 6-digit authenticator code.');
  }

  const userId = await assertAuthenticatedAdministrator(supabase, expectedSubject);

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: normalizedFactorId,
    code: normalizedCode,
  });
  if (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Invalid or expired authenticator verification code.',
    );
  }

  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || aal?.currentLevel !== 'aal2') {
    throw new Error('Supabase AAL2 verification did not complete.');
  }

  let sessionResult = await supabase.auth.getSession();
  if (supabase.auth.refreshSession) {
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data?.session?.access_token) {
      sessionResult = refreshed;
    }
  }

  const activeSession = sessionResult.data?.session;
  if (!activeSession?.access_token) {
    throw new Error('No authenticated AAL2 access token returned.');
  }
  if (activeSession.user?.id && activeSession.user.id !== userId) {
    clearPendingExternalTotpFactor();
    throw new Error('Authenticated session identity mismatch after MFA verification.');
  }

  clearPendingExternalTotpFactor();
  return {
    accessToken: activeSession.access_token,
    userId,
    aal: 'aal2' as const,
  };
}

export async function signOutExternalStagingSession(
  clientOverride?: ExternalStagingSupabaseClientLike | null,
): Promise<void> {
  clearPendingExternalTotpFactor();
  const supabase = clientOverride !== undefined ? clientOverride : getExternalStagingMfaClient();
  if (!supabase) return;
  try {
    await supabase.auth.signOut();
  } catch {
    // Ensure client state still clears even if provider signOut fails offline.
  }
}

export function resetExternalStagingClientForTests(): void {
  client = null;
  clearPendingExternalTotpFactor();
}
