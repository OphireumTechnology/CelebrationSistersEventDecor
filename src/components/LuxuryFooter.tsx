import { BrandLogo } from './BrandLogo';
import { SERVICE_DIVISIONS, SERVICE_LOCATIONS } from '../data/brandCatalog';
import type { AppRoute } from './LuxuryHeader';

interface LuxuryFooterProps {
  onNavigate: (route: AppRoute) => void;
  onSelectService: (serviceId: string) => void;
  onOpenBooking: () => void;
}

export function LuxuryFooter({ onNavigate, onSelectService, onOpenBooking }: LuxuryFooterProps) {
  return (
    <footer className="bg-[var(--cs-ivory)] border-t border-[var(--cs-border)] text-[var(--cs-charcoal)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-12 pb-12 border-b border-[var(--cs-border)]">
          {/* Brand Column */}
          <div className="md:col-span-4 space-y-5">
            <div className="flex items-center gap-3">
              <BrandLogo heightClass="h-14" />
            </div>
            <p className="text-sm leading-relaxed text-[var(--cs-charcoal-muted)] max-w-sm">
              Luxury event planning, architectural decor, coordination, entertainment, and production studio headquartered in Columbia, South Carolina.
            </p>
            <div className="text-xs space-y-1 text-[var(--cs-charcoal-muted)]">
              <p className="font-medium text-[var(--cs-charcoal)]">Columbia Design Atelier</p>
              <p>Columbia, South Carolina · By Private Appointment</p>
              <p>concierge@celebrationsisters.example.com · (803) 555-0180</p>
            </div>
          </div>

          {/* 12 Service Divisions */}
          <div className="md:col-span-5">
            <h3 className="text-xs font-semibold tracking-wider text-[var(--cs-purple)] mb-4">
              Event Service Divisions
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {SERVICE_DIVISIONS.map((service) => (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => {
                    onSelectService(service.id);
                    onNavigate('services');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="text-left text-xs text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] transition-colors py-0.5 cursor-pointer"
                >
                  {service.number}. {service.title}
                </button>
              ))}
            </div>
          </div>

          {/* Locations & Actions */}
          <div className="md:col-span-3 space-y-5">
            <div>
              <h3 className="text-xs font-semibold tracking-wider text-[var(--cs-purple)] mb-3">
                Service Territories
              </h3>
              <ul className="space-y-1.5 text-xs text-[var(--cs-charcoal-muted)]">
                {SERVICE_LOCATIONS.map((loc) => (
                  <li key={loc.city}>{loc.city}</li>
                ))}
              </ul>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={onOpenBooking}
                className="w-full px-4 py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer"
              >
                Schedule Private Consultation
              </button>
            </div>
          </div>
        </div>

        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[var(--cs-charcoal-muted)]">
          <p>© {new Date().getFullYear()} Celebration Sisters Event Decor LLC · Columbia, South Carolina</p>
          <div className="flex items-center gap-6">
            <button type="button" onClick={() => onNavigate('services')} className="hover:text-[var(--cs-purple)] cursor-pointer">
              Service Standards
            </button>
            <button type="button" onClick={() => onNavigate('ai-studio')} className="hover:text-[var(--cs-purple)] cursor-pointer">
              AI Concierge
            </button>
            <button type="button" onClick={() => onNavigate('portals')} className="hover:text-[var(--cs-purple)] cursor-pointer">
              Client & Operations Portals
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
