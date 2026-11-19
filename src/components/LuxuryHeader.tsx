import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BrandLogo } from './BrandLogo';

export type AppRoute = 'home' | 'services' | 'portfolio' | 'ai-studio' | 'portals';

interface LuxuryHeaderProps {
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onOpenBooking: () => void;
}

const NAV_ITEMS: { id: AppRoute; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'services', label: 'Services' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'ai-studio', label: 'AI Studio' },
  { id: 'portals', label: 'Portals' },
];

export function LuxuryHeader({ activeRoute, onNavigate, onOpenBooking }: LuxuryHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen]);

  const handleNav = (route: AppRoute) => {
    onNavigate(route);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-[var(--cs-border)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 md:h-20 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Official Brand Lockup */}
        <button
          type="button"
          onClick={() => handleNav('home')}
          className="flex items-center gap-3 text-left shrink-0 whitespace-nowrap group"
          aria-label="Celebration Sisters Event Decor Home"
        >
          <BrandLogo heightClass="h-10 md:h-12" />
          <span className="font-display text-lg md:text-xl font-semibold tracking-tight text-[var(--cs-purple)] whitespace-nowrap shrink-0">
            Celebration Sisters
          </span>
        </button>

        {/* Zone 2: 5 concise single-line text links */}
        <nav className="hidden md:flex items-center gap-8" aria-label="Primary Navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = activeRoute === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => handleNav(item.id)}
                className={`relative py-1 text-sm font-medium tracking-wide whitespace-nowrap shrink-0 transition-colors duration-200 ${
                  isActive
                    ? 'text-[var(--cs-purple)] font-semibold'
                    : 'text-[var(--cs-charcoal)] hover:text-[var(--cs-purple)]'
                }`}
              >
                {item.label}
                <span
                  className={`absolute left-0 right-0 -bottom-0.5 h-[1.5px] transition-opacity duration-200 ${
                    isActive ? 'bg-[var(--cs-gold)] opacity-100' : 'bg-[var(--cs-gold)] opacity-0'
                  }`}
                />
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenBooking}
            className="hidden sm:inline-flex items-center justify-center px-5 py-2.5 text-xs md:text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors duration-200 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Book a Consultation
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            className="md:hidden p-2.5 text-[var(--cs-charcoal)] hover:text-[var(--cs-purple)] rounded-md"
            aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileOpen && (
        <div className="md:hidden bg-white border-t border-[var(--cs-border)] px-6 py-5 space-y-3">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activeRoute === item.id ? 'page' : undefined}
              onClick={() => handleNav(item.id)}
              className={`block w-full text-left py-2.5 text-sm font-medium border-b border-[var(--cs-border)]/60 ${
                activeRoute === item.id ? 'text-[var(--cs-purple)] font-semibold' : 'text-[var(--cs-charcoal)]'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setMobileOpen(false);
              onOpenBooking();
            }}
            className="w-full mt-2 px-5 py-3 text-sm font-medium text-white bg-[var(--cs-purple)] rounded-md"
          >
            Book a Consultation
          </button>
        </div>
      )}
    </header>
  );
}
