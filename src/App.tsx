import { apiFetch, isBackendConfigured } from './lib/apiClient';
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

  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [bookingPrefill, setBookingPrefill] = useState<{
    serviceId?: string;
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }>({});

  useEffect(() => {
    const loadPersonas = async () => {
      try {
        const res = await apiFetch('/api/auth/personas');
        if (!res.ok) return;
        const data = await res.json();
        const list: UserSession[] = data.personas || [];
        setPersonas(list);
        if (list.length > 0) {
          setCurrentUser(list[0]); // Default authenticated client demo session when entering Portals
        }
      } catch {
        // Keep guest fallback if offline
      }
    };
    loadPersonas();
  }, []);

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
      {!isBackendConfigured && (
        <div role="status" className="bg-[var(--cs-ivory)] border-b border-[var(--cs-border)] px-4 py-2 text-center text-xs text-[var(--cs-charcoal)]">
          Our portfolio is available to explore. Online booking, AI consultations, and private portals will open when secure hosting is connected.
        </div>
      )}
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
            personas={personas}
            onSwitchPersona={(user) => setCurrentUser(user)}
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
