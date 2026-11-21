import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent } from 'react';

interface RecoveryTokens {
  access_token: string;
  refresh_token: string;
}

interface RecoveryCallback {
  tokens: RecoveryTokens | null;
}

export function consumeRecoveryCallback(): RecoveryCallback | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const isRecovery = fragment.get('type') === 'recovery';
  if (url.searchParams.get('auth') !== 'recovery' && !isRecovery) return null;

  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  for (const parameter of ['auth', 'code', 'error', 'error_code', 'error_description']) {
    url.searchParams.delete(parameter);
  }
  url.hash = '';
  window.history.replaceState(window.history.state, '', url);
  return {
    tokens: isRecovery && accessToken && refreshToken
      ? { access_token: accessToken, refresh_token: refreshToken }
      : null,
  };
}

const INVALID_LINK = 'This recovery link is invalid or expired. Request a new link from the portal.';

export function PasswordRecovery({ tokens, onReturn }: RecoveryCallback & { onReturn: () => void }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(Boolean(tokens));
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [message, setMessage] = useState(tokens ? '' : INVALID_LINK);

  useEffect(() => {
    if (!tokens) return;
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) {
      setMessage('Password recovery is unavailable. Contact the portal administrator.');
      setLoading(false);
      return;
    }
    let active = true;
    const restoreRecoverySession = async () => {
      try {
        const recoveryClient = createClient(url, key, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false,
            storageKey: 'celebration-password-recovery',
          },
        });
        const { data, error } = await recoveryClient.auth.setSession(tokens);
        if (!active) return;
        if (error || !data.session) {
          setMessage(INVALID_LINK);
          return;
        }
        setClient(recoveryClient);
      } catch {
        if (active) setMessage(INVALID_LINK);
      } finally {
        if (active) setLoading(false);
      }
    };
    void restoreRecoverySession();
    return () => { active = false; };
  }, [tokens]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || submitting) return;
    if (password !== confirmation) {
      setMessage('The passwords must match.');
      return;
    }
    setMessage('');
    setSubmitting(true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        setMessage(error.code === 'weak_password' || error.code === 'same_password'
          ? 'Choose a new, stronger password.'
          : 'Unable to reset the password. Request a new recovery link and try again.');
        return;
      }
      setPassword('');
      setConfirmation('');
      setClient(null);
      setComplete(true);
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    } catch {
      setMessage('Password recovery is temporarily unavailable. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'block w-full rounded-md border border-[var(--cs-border-strong)] px-3 py-2 text-base';

  return (
    <main className="min-h-screen bg-white px-5 py-16 text-[var(--cs-charcoal)]">
      <section className="mx-auto max-w-md space-y-5">
        <h1 className="text-3xl font-semibold">Reset your password</h1>
        {loading && <p role="status">Checking your recovery link…</p>}
        {complete && <p role="status">Password updated. Sign in with your new password.</p>}
        {message && <p role="alert">{message}</p>}
        {client && !complete && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block space-y-1">
              <span>New password</span>
              <input className={inputClass} type="password" autoComplete="new-password" required
                minLength={6} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>Confirm new password</span>
              <input className={inputClass} type="password" autoComplete="new-password" required
                minLength={6} maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </label>
            <button className="min-h-11 w-full rounded-md bg-[var(--cs-purple)] text-white disabled:opacity-50"
              type="submit" disabled={submitting}>
              {submitting ? 'Updating password…' : 'Update password'}
            </button>
          </form>
        )}
        <button type="button" disabled={submitting} onClick={onReturn}
          className="min-h-11 text-[var(--cs-purple)] underline disabled:opacity-50">
          Return to portal
        </button>
      </section>
    </main>
  );
}
