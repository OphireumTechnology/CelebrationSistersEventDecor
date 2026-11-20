/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { AIStudioWorkspace } from './components/AIStudioWorkspace';
import { ConsultationModal } from './components/ConsultationModal';
import { LuxuryFooter } from './components/LuxuryFooter';
import { LuxuryHeader, type AppRoute } from './components/LuxuryHeader';
import { PortfolioAndAboutView } from './components/PortfolioAndAboutView';
import { PortalsWorkspace } from './components/PortalsWorkspace';
import { PublicHomeView } from './components/PublicHomeView';
import { ServiceDivisionCatalog } from './components/ServiceDivisionCatalog';
import { apiFetch, isBackendConfigured, setApiAccessToken, setApiCsrfToken } from './lib/apiClient';
import type { UserSession } from './types/domain';
import {
  clearPendingExternalTotpFactor,
  enrollExternalStagingTotp,
  getExternalStagingMfaClient,
  getPendingExternalTotpFactorId,
  resolveExternalTotpFactorId,
  signOutExternalStagingSession,
  verifyExternalStagingTotp,
} from './lib/externalStagingMfa';

const DEFAULT_GUEST: UserSession = {
  id: 'guest-public',
  name: 'Public Visitor',
  email: 'visitor@celebrationsisters.example.com',
  role: 'guest',
};

export interface TotpEnrollmentResult {
  ok: boolean;
  error?: string;
  factorId?: string;
  qrCode?: string;
  secret?: string;
  otpauthUri?: string;
  recoveryCodes?: string[];
}

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRoute>('home');
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const externalStagingMode = Boolean(getExternalStagingMfaClient());
  const [personas, setPersonas] = useState<UserSession[]>([]);
  const [currentUser, setCurrentUser] = useState<UserSession>(DEFAULT_GUEST);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [hasPendingExternalFactor, setHasPendingExternalFactor] = useState(
    () => Boolean(getPendingExternalTotpFactorId()),
  );
  const [authProviderReady, setAuthProviderReady] = useState(false);

  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [bookingPrefill, setBookingPrefill] = useState<{
    serviceId?: string;
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }>({});

  useEffect(() => {
    if (!isBackendConfigured) {
      return;
    }

    let mounted = true;
    const externalClient = getExternalStagingMfaClient();

    const syncBackendSession = async () => {
      const sessionRes = await apiFetch('/api/auth/session', { credentials: 'include' });
      if (!mounted) return;
      if (sessionRes.ok) {
        const sData = await sessionRes.json();
        if (!mounted) return;
        setApiCsrfToken(sData.csrfToken ?? null);
        if (sData.user) {
          setCurrentUser(sData.user);
          setMfaRequired(Boolean(sData.mfaRequired));
          setMfaEnrolled(Boolean(sData.mfaEnrolled || sData.user.mfaEnrolled));
        } else {
          setCurrentUser(DEFAULT_GUEST);
          setMfaRequired(false);
          setMfaEnrolled(false);
        }
      }
    };

    const initAuth = async () => {
      try {
        if (externalClient) {
          const { data: extData } = await externalClient.auth.getSession();
          if (extData?.session?.access_token) {
            setApiAccessToken(extData.session.access_token);
            setHasPendingExternalFactor(
              Boolean(getPendingExternalTotpFactorId(extData.session.user?.id)),
            );
          } else {
            setApiAccessToken(null);
            clearPendingExternalTotpFactor();
            setHasPendingExternalFactor(false);
          }
        }

        const [configRes] = await Promise.all([
          apiFetch('/api/auth/config', { credentials: 'include' }),
          syncBackendSession(),
        ]);

        if (mounted && configRes.ok) {
          const cfg = await configRes.json();
          if (!mounted) return;
          setAuthProviderReady(Boolean(cfg.readyForProductionAuth));
          if (cfg.demoPersonasAvailable === true) {
            const personasRes = await apiFetch('/api/auth/personas', { credentials: 'include' });
            if (mounted && personasRes.ok) {
              const pData = await personasRes.json();
              if (mounted) setPersonas(pData.personas || []);
            }
          }
        }
      } catch {
        // Keep guest fallback if offline
      }
    };

    void initAuth();

    let unsubscribe: (() => void) | undefined;
    if (externalClient) {
      const { data: listenerData } = externalClient.auth.onAuthStateChange((event, session) => {
        if (!mounted) return;
        if (event === 'SIGNED_OUT' || !session?.access_token) {
          clearPendingExternalTotpFactor();
          setHasPendingExternalFactor(false);
          setApiAccessToken(null);
          setApiCsrfToken(null);
          setCurrentUser(DEFAULT_GUEST);
          setMfaRequired(false);
          setMfaEnrolled(false);
          return;
        }
        setApiAccessToken(session.access_token);
        setHasPendingExternalFactor(Boolean(getPendingExternalTotpFactorId(session.user?.id)));
        if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          void syncBackendSession();
        }
      });
      unsubscribe = () => listenerData.subscription.unsubscribe();
    }

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const handleSwitchPersona = async (user: UserSession) => {
    const res = await apiFetch('/api/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: user.id }),
    });
    if (!res.ok) return;
    const data = await res.json();
    setApiCsrfToken(data.csrfToken ?? null);
    setCurrentUser(data.user);
    setMfaRequired(Boolean(data.mfaRequired));
    setMfaEnrolled(Boolean(data.user?.mfaEnrolled));
  };

  const handleEmailLogin = async (
    email: string,
    password: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const externalClient = getExternalStagingMfaClient();
      if (externalClient) {
        const { data: externalLogin, error: externalError } =
          await externalClient.auth.signInWithPassword({ email, password });
        if (externalError || !externalLogin.session?.access_token) {
          return {
            ok: false,
            error: externalError?.message || 'Sign-in failed. Verify your email and password.',
          };
        }

        setApiAccessToken(externalLogin.session.access_token);
        const sessionRes = await apiFetch('/api/auth/session', { credentials: 'include' });
        const sData = await sessionRes.json().catch(() => ({}));
        if (!sessionRes.ok || !sData.user || sData.user.role === 'guest') {
          await signOutExternalStagingSession();
          setHasPendingExternalFactor(false);
          setApiAccessToken(null);
          setApiCsrfToken(null);
          setCurrentUser(DEFAULT_GUEST);
          setMfaRequired(false);
          setMfaEnrolled(false);
          return {
            ok: false,
            error:
              sData.error ||
              'Authenticated account is not authorized for this staging portal session.',
          };
        }

        setApiCsrfToken(sData.csrfToken ?? null);
        setCurrentUser(sData.user);
        setMfaRequired(Boolean(sData.mfaRequired));
        setMfaEnrolled(Boolean(sData.mfaEnrolled || sData.user?.mfaEnrolled));
        setHasPendingExternalFactor(
          Boolean(getPendingExternalTotpFactorId(externalLogin.session.user?.id)),
        );
        return { ok: true };
      }

      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Sign-in failed. Verify your email and password.' };
      }
      if (data.token) {
        setApiAccessToken(data.token);
      }
      setApiCsrfToken(data.csrfToken ?? null);
      setCurrentUser(data.user);
      setMfaRequired(Boolean(data.mfaRequired));
      setMfaEnrolled(Boolean(data.mfaEnrolled || data.user?.mfaEnrolled));
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to reach the authentication server.' };
    }
  };

  const handlePasswordReset = async (email: string): Promise<{ ok: boolean; message?: string; error?: string }> => {
    try {
      const res = await apiFetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Password reset request could not be completed.' };
      }
      return { ok: true, message: data.message || 'Recovery instructions dispatched.' };
    } catch {
      return { ok: false, error: 'Unable to reach the authentication server.' };
    }
  };

  const handleVerifyMfa = async (code: string): Promise<{ ok: boolean; error?: string }> => {
    const externalClient = getExternalStagingMfaClient();
    if (externalClient) {
      try {
        const factorId = await resolveExternalTotpFactorId();
        if (!factorId) {
          return { ok: false, error: 'Enroll an authenticator before verifying MFA.' };
        }
        const verified = await verifyExternalStagingTotp(factorId, code);
        setApiAccessToken(verified.accessToken);
        setHasPendingExternalFactor(false);

        const sessionRes = await apiFetch('/api/auth/session', { credentials: 'include' });
        const sData = await sessionRes.json().catch(() => ({}));
        if (!sessionRes.ok || !sData.mfaVerified || sData.aal !== 'aal2' || !sData.user) {
          return {
            ok: false,
            error:
              sData.error ||
              'Backend session did not confirm Supabase AAL2 verification. Please retry.',
          };
        }

        setApiCsrfToken(sData.csrfToken ?? null);
        setCurrentUser(sData.user);
        setMfaRequired(false);
        setMfaEnrolled(true);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'External MFA verification failed.' };
      }
    }
    const res = await apiFetch('/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || 'MFA verification failed.' };
    }
    setApiCsrfToken(data.csrfToken ?? null);
    setMfaRequired(false);
    setCurrentUser(data.user);
    return { ok: true };
  };

  const handleEnrollTotp = async (
    optionsOrRecoveryCode?: string | { replaceUnverified?: boolean },
  ): Promise<TotpEnrollmentResult> => {
    if (getExternalStagingMfaClient()) {
      try {
        const replaceUnverified =
          typeof optionsOrRecoveryCode === 'object'
            ? Boolean(optionsOrRecoveryCode?.replaceUnverified)
            : false;
        const factor = await enrollExternalStagingTotp({ replaceUnverified });
        setHasPendingExternalFactor(true);
        return {
          ok: true,
          factorId: factor.factorId,
          qrCode: factor.qr,
          secret: factor.secret,
          otpauthUri: factor.uri,
          recoveryCodes: [],
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'External MFA enrollment failed.' };
      }
    }
    try {
      const recoveryCode =
        typeof optionsOrRecoveryCode === 'string' ? optionsOrRecoveryCode : undefined;
      const res = await apiFetch('/api/auth/mfa/totp/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(recoveryCode ? { recoveryCode } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Unable to enroll TOTP authenticator.' };
      }
      setMfaEnrolled(true);
      return {
        ok: true,
        secret: data.secret,
        otpauthUri: data.otpauthUri,
        recoveryCodes: Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [],
      };
    } catch {
      return { ok: false, error: 'Unable to reach the MFA enrollment endpoint.' };
    }
  };

  const handleRecoverMfa = async (
    recoveryCode: string,
  ): Promise<{ ok: boolean; remainingRecoveryCodes?: number; error?: string }> => {
    try {
      const res = await apiFetch('/api/auth/mfa/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recoveryCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Invalid or already-used recovery code.' };
      }
      setApiCsrfToken(data.csrfToken ?? null);
      setMfaRequired(false);
      setCurrentUser(data.user);
      return { ok: true, remainingRecoveryCodes: data.remainingRecoveryCodes };
    } catch {
      return { ok: false, error: 'Unable to verify recovery code.' };
    }
  };

  const handleLogout = async () => {
    try {
      await signOutExternalStagingSession();
      await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null);
    } finally {
      clearPendingExternalTotpFactor();
      setHasPendingExternalFactor(false);
      setApiAccessToken(null);
      setApiCsrfToken(null);
      setCurrentUser(DEFAULT_GUEST);
      setMfaRequired(false);
      setMfaEnrolled(false);
    }
  };

  const openBooking = (serviceId?: string) => {
    setBookingPrefill(serviceId ? { serviceId } : {});
    setBookingModalOpen(true);
  };

  const openBookingWithPrefill = (prefill: {
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }) => {
    setBookingPrefill(prefill);
    setBookingModalOpen(true);
  };

  const handleNavigate = (route: AppRoute) => {
    setActiveRoute(route);
    if (route !== 'services') {
      setSelectedServiceId(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-white text-[var(--cs-charcoal)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[var(--cs-purple)] focus:text-white focus:rounded-md focus:text-xs focus:font-medium"
      >
        Skip to main content
      </a>
      <LuxuryHeader
        activeRoute={activeRoute}
        onNavigate={handleNavigate}
        onOpenBooking={() => openBooking()}
      />

      <main id="main-content" className="flex-1">
        {activeRoute === 'home' && (
          <PublicHomeView
            onNavigate={handleNavigate}
            onSelectService={(id) => setSelectedServiceId(id)}
            onOpenBooking={(serviceId) => openBooking(serviceId)}
          />
        )}

        {activeRoute === 'services' && (
          <ServiceDivisionCatalog
            selectedServiceId={selectedServiceId}
            onSelectService={setSelectedServiceId}
            onOpenBooking={(serviceId) => openBooking(serviceId)}
          />
        )}

        {activeRoute === 'portfolio' && (
          <PortfolioAndAboutView onOpenBooking={() => openBooking()} />
        )}

        {activeRoute === 'ai-studio' && (
          <AIStudioWorkspace
            currentUser={currentUser}
            onOpenBookingPrefilled={openBookingWithPrefill}
          />
        )}

        {activeRoute === 'portals' && (
          <PortalsWorkspace
            currentUser={currentUser}
            mfaRequired={mfaRequired}
            mfaEnrolled={mfaEnrolled}
            externalStagingMode={externalStagingMode}
            hasPendingExternalFactor={hasPendingExternalFactor}
            authProviderReady={authProviderReady}
            personas={personas}
            onSwitchPersona={handleSwitchPersona}
            onEmailLogin={handleEmailLogin}
            onPasswordReset={handlePasswordReset}
            onVerifyMfa={handleVerifyMfa}
            onEnrollTotp={handleEnrollTotp}
            onRecoverMfa={handleRecoverMfa}
            onLogout={handleLogout}
          />
        )}
      </main>

      <LuxuryFooter
        onNavigate={handleNavigate}
        onSelectService={(id) => setSelectedServiceId(id)}
        onOpenBooking={() => openBooking()}
      />

      <ConsultationModal
        open={bookingModalOpen}
        initialServiceId={bookingPrefill.serviceId}
        initialEventType={bookingPrefill.eventType}
        initialLocation={bookingPrefill.location}
        initialGuestCount={bookingPrefill.guestCount}
        initialNotes={bookingPrefill.notes}
        onClose={() => setBookingModalOpen(false)}
      />
    </div>
  );
}
