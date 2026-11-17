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
import { apiFetch } from './lib/apiClient';
import type { UserSession } from './types/domain';

const DEFAULT_GUEST: UserSession = {
  id: 'guest-public',
  name: 'Public Visitor',
  email: 'visitor@celebrationsisters.example.com',
  role: 'guest',
};

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRoute>('home');
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const [personas, setPersonas] = useState<UserSession[]>([]);
  const [currentUser, setCurrentUser] = useState<UserSession>(DEFAULT_GUEST);
  const [mfaRequired, setMfaRequired] = useState(false);

  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [bookingPrefill, setBookingPrefill] = useState<{
    serviceId?: string;
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }>({});

  useEffect(() => {
    const initAuth = async () => {
      try {
        const [personasRes, sessionRes] = await Promise.all([
          apiFetch('/api/auth/personas', { credentials: 'include' }),
          apiFetch('/api/auth/session', { credentials: 'include' }),
        ]);
        if (personasRes.ok) {
          const pData = await personasRes.json();
          setPersonas(pData.personas || []);
        }
        if (sessionRes.ok) {
          const sData = await sessionRes.json();
          if (sData.user) {
            setCurrentUser(sData.user);
            setMfaRequired(Boolean(sData.mfaRequired));
          }
        }
      } catch {
        // Keep guest fallback if offline
      }
    };
    initAuth();
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
    setCurrentUser(data.user);
    setMfaRequired(Boolean(data.mfaRequired));
  };

  const handleVerifyMfa = async (code: string): Promise<{ ok: boolean; error?: string }> => {
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
    setMfaRequired(false);
    setCurrentUser(data.user);
    return { ok: true };
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setCurrentUser(DEFAULT_GUEST);
    setMfaRequired(false);
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
      <LuxuryHeader
        activeRoute={activeRoute}
        onNavigate={handleNavigate}
        onOpenBooking={() => openBooking()}
      />

      <main className="flex-1">
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
            personas={personas}
            onSwitchPersona={handleSwitchPersona}
            onVerifyMfa={handleVerifyMfa}
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
