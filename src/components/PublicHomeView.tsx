import { useState } from 'react';
import { ArrowRight, Check, Sparkles, X } from 'lucide-react';
import {
  APPROVED_TESTIMONIALS,
  HERO_BALLROOM_IMAGE,
  PORTFOLIO_ITEMS,
  SERVICE_DIVISIONS,
  SIGNATURE_EXPERIENCE_STEPS,
  type PortfolioItem,
} from '../data/brandCatalog';
import type { AppRoute } from './LuxuryHeader';

interface PublicHomeViewProps {
  onNavigate: (route: AppRoute) => void;
  onSelectService: (serviceId: string) => void;
  onOpenBooking: (serviceId?: string) => void;
}

const PORTFOLIO_CATEGORIES = ['All', 'Weddings', 'Social & Milestones', 'Corporate & Brand', 'Lighting & Lounge'] as const;

export function PublicHomeView({ onNavigate, onSelectService, onOpenBooking }: PublicHomeViewProps) {
  const [portfolioFilter, setPortfolioFilter] = useState<(typeof PORTFOLIO_CATEGORIES)[number]>('All');
  const [lightboxItem, setLightboxItem] = useState<PortfolioItem | null>(null);

  const featuredDivisions = [
    SERVICE_DIVISIONS[0], // Wedding Planning & Design
    SERVICE_DIVISIONS[6], // Luxury Decor & Styling
    SERVICE_DIVISIONS[4], // Corporate Events
    SERVICE_DIVISIONS[10], // Event Lighting & Production
  ];

  const visiblePortfolio =
    portfolioFilter === 'All'
      ? PORTFOLIO_ITEMS
      : PORTFOLIO_ITEMS.filter((item) => item.category === portfolioFilter);

  return (
    <div className="bg-white text-[var(--cs-charcoal)]">
      {/* Section 2: Cinematic Hero */}
      <section className="relative overflow-hidden bg-[#1D1230]">
        <div className="relative min-h-[560px] lg:min-h-[640px] flex items-center">
          <img
            src={HERO_BALLROOM_IMAGE}
            alt="Celebration Sisters luxury ballroom wedding reception in Columbia, South Carolina"
            referrerPolicy="no-referrer"
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div
            className="absolute inset-0 bg-gradient-to-r from-[#1A0D2E]/88 via-[#1A0D2E]/65 to-[#1A0D2E]/25"
            aria-hidden="true"
          />
          <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-28 w-full">
            <div className="max-w-2xl space-y-6">
              <p className="text-xs font-medium tracking-[0.22em] text-[#E6C98F] uppercase">
                Columbia, South Carolina · Luxury Event Production
              </p>
              <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-semibold text-white leading-[1.12]">
                Every Celebration, Beautifully Extraordinary.
              </h1>
              <p className="text-base sm:text-lg text-[#FAF8F4]/90 leading-relaxed max-w-xl">
                Elegant design. Thoughtful planning. Timeless memories.
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => onOpenBooking()}
                  className="px-6 py-3.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] border border-[#B99045]/40 rounded-md transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  Plan Your Celebration
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('services')}
                  className="px-6 py-3.5 text-sm font-medium text-white bg-white/10 hover:bg-white/20 border border-white/30 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  Explore Our Services
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Full-width Quiet Architectural Strip below Hero */}
        <div className="bg-[var(--cs-ivory)] border-b border-[var(--cs-border)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 grid grid-cols-2 lg:grid-cols-4 gap-6 text-xs">
            <div>
              <p className="font-semibold text-[var(--cs-purple)]">Headquarters</p>
              <p className="text-[var(--cs-charcoal-muted)] mt-0.5">Columbia, South Carolina</p>
            </div>
            <div>
              <p className="font-semibold text-[var(--cs-purple)]">Service Scope</p>
              <p className="text-[var(--cs-charcoal-muted)] mt-0.5">12 Specialized Event Divisions</p>
            </div>
            <div>
              <p className="font-semibold text-[var(--cs-purple)]">Design Intelligence</p>
              <p className="text-[var(--cs-charcoal-muted)] mt-0.5">AI Concierge & Concept Studio</p>
            </div>
            <div>
              <p className="font-semibold text-[var(--cs-purple)]">Client Workspace</p>
              <p className="text-[var(--cs-charcoal-muted)] mt-0.5">Quotes, Contracts & Timelines</p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Columbia Studio Introduction */}
      <section className="py-20 lg:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-5 space-y-4">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Our Atelier
            </p>
            <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)] leading-tight">
              Southern Grace Meets Architectural Precision
            </h2>
          </div>
          <div className="lg:col-span-7 space-y-5 text-[var(--cs-charcoal-muted)] text-sm sm:text-base leading-relaxed">
            <p>
              Based in Columbia, South Carolina, Celebration Sisters Event Decor is a luxury planning, floral styling, and full-scale event production studio. Whether orchestrating an heirloom estate wedding, an intimate Lake Murray milestone dinner, or a 400-guest corporate awards gala, we unify creative design with disciplined logistics.
            </p>
            <p>
              Every engagement is supported by our dedicated planners, vetted Midlands vendor network, curated rental inventory, and private Client Portal—ensuring transparency from initial mood board through final candle strike.
            </p>
            <div className="pt-2 flex flex-wrap gap-6 text-xs font-medium text-[var(--cs-purple)]">
              <button
                type="button"
                onClick={() => onNavigate('portfolio')}
                className="inline-flex items-center gap-1.5 hover:underline cursor-pointer"
              >
                About Our Columbia Studio
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('ai-studio')}
                className="inline-flex items-center gap-1.5 hover:underline cursor-pointer"
              >
                Preview AI Concept Studio
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Featured Services (Asymmetric Bento Grid) */}
      <section className="py-20 lg:py-24 bg-[var(--cs-ivory)] border-y border-[var(--cs-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
            <div className="space-y-3 max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
                Featured Divisions
              </p>
              <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
                Twelve Specialized Event Capabilities Under One Roof
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('services')}
              className="px-5 py-2.5 text-xs font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple)] hover:text-white rounded-md transition-colors whitespace-nowrap self-start md:self-auto cursor-pointer"
            >
              View All 12 Divisions
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {featuredDivisions.map((div, index) => {
              const isWide = index === 0 || index === 3;
              return (
                <article
                  key={div.id}
                  onClick={() => {
                    onSelectService(div.id);
                    onNavigate('services');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className={`${
                    isWide ? 'lg:col-span-7' : 'lg:col-span-5'
                  } group bg-white border border-[var(--cs-border)] rounded-lg overflow-hidden cursor-pointer transition-colors hover:border-[var(--cs-gold)] flex flex-col`}
                >
                  <div className="aspect-[16/10] w-full overflow-hidden bg-[var(--cs-ivory)]">
                    <img
                      src={div.heroImage}
                      alt={div.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  </div>
                  <div className="p-6 sm:p-7 flex-1 flex flex-col justify-between space-y-4">
                    <div className="space-y-2">
                      <p className="text-xs text-[var(--cs-gold-muted)] font-medium">
                        {div.number} · {div.category}
                      </p>
                      <h3 className="font-display text-xl sm:text-2xl font-semibold text-[var(--cs-purple)]">
                        {div.title}
                      </h3>
                      <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                        {div.tagline}
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--cs-purple)] group-hover:translate-x-0.5 transition-transform">
                      Explore Division Details
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Section 5: Our Signature Experience */}
      <section className="py-20 lg:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-3 mb-14">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Our Signature Experience
            </p>
            <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
              A Calm, Disciplined Path From Vision to Celebration
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-8 border-t border-[var(--cs-border)] pt-10">
            {SIGNATURE_EXPERIENCE_STEPS.map((item) => (
              <div key={item.step} className="space-y-3">
                <p className="font-display text-2xl font-semibold text-[var(--cs-gold)] tabular-nums">
                  {item.step}
                </p>
                <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                  {item.title}
                </h3>
                <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 6: Filterable Event Portfolio */}
      <section className="py-20 lg:py-24 bg-[var(--cs-ivory)] border-y border-[var(--cs-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-10">
            <div className="space-y-2">
              <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
                Verified Portfolio Gallery
              </p>
              <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
                Selected Productions Across the Carolinas
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 bg-white border border-[var(--cs-border)] p-1 rounded-lg">
              {PORTFOLIO_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setPortfolioFilter(cat)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    portfolioFilter === cat
                      ? 'bg-[var(--cs-purple)] text-white'
                      : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visiblePortfolio.map((item) => (
              <article
                key={item.id}
                onClick={() => setLightboxItem(item)}
                className="bg-white border border-[var(--cs-border)] rounded-lg overflow-hidden cursor-pointer group hover:border-[var(--cs-gold)] transition-colors"
              >
                <div className="aspect-[4/3] overflow-hidden bg-[var(--cs-ivory)]">
                  <img
                    src={item.image}
                    alt={item.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                </div>
                <div className="p-5 space-y-2">
                  <div className="text-xs text-[var(--cs-charcoal-muted)] flex items-center gap-2">
                    <span>{item.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.location}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{item.guestCount} Guests</span>
                  </div>
                  <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                    {item.title}
                  </h3>
                  <p className="text-xs text-[var(--cs-charcoal-muted)] leading-relaxed">
                    {item.caption}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Section 7 & 8: Personalized Packages + AI Event Concierge & Concept Studio */}
      <section className="py-20 lg:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-6 border border-[var(--cs-border)] rounded-lg p-8 sm:p-10 flex flex-col justify-between space-y-6 bg-[var(--cs-ivory)]">
            <div className="space-y-4">
              <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
                Personalized Packages
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-purple)]">
                Consultation-Based Quotations Tailored to Your Room
              </h2>
              <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                Because no two venues, floral stems, or guest lists are identical, we never publish rigid cookie-cutter pricing. Every proposal is itemized by division with clear deposit milestones and version history.
              </p>
              <ul className="space-y-2.5 pt-2 text-xs sm:text-sm text-[var(--cs-charcoal)]">
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-[var(--cs-gold)] shrink-0" />
                  <span>Transparent itemized line items across all 12 divisions</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-[var(--cs-gold)] shrink-0" />
                  <span>Date-locked inventory allocation & digital contracts</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-[var(--cs-gold)] shrink-0" />
                  <span>Private Client Portal access upon consultation intake</span>
                </li>
              </ul>
            </div>
            <div>
              <button
                type="button"
                onClick={() => onOpenBooking()}
                className="px-6 py-3 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer"
              >
                Request Custom Quotation
              </button>
            </div>
          </div>

          <div className="lg:col-span-6 border border-[var(--cs-purple)]/25 rounded-lg p-8 sm:p-10 flex flex-col justify-between space-y-6 bg-[#2A114E] text-white">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 text-xs font-medium tracking-[0.16em] text-[#E6C98F] uppercase">
                <Sparkles className="w-4 h-4" />
                <span>AI Event Concierge & Concept Studio</span>
              </div>
              <h2 className="font-display text-2xl sm:text-3xl font-semibold text-white">
                Explore Your Celebration Concept in Minutes
              </h2>
              <p className="text-sm text-white/85 leading-relaxed">
                Converse with our guided AI Event Concierge to clarify guest counts, divisions, and preliminary recommendations—or step inside the AI Event Concept Studio to compose a custom floral, lighting, and tablescape mood board for planner review.
              </p>
              <p className="text-xs text-[#E6C98F]/90 leading-relaxed">
                All AI concepts are clearly marked as conceptual visualizations; final pricing, date availability, and approvals remain confirmed exclusively by our Columbia planning team.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('ai-studio')}
                className="px-6 py-3 text-sm font-medium text-[var(--cs-purple)] bg-white hover:bg-[var(--cs-ivory)] rounded-md transition-colors cursor-pointer"
              >
                Launch AI Concierge & Studio
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Section 9: Approved Client Testimonials */}
      <section className="py-20 lg:py-24 bg-[var(--cs-ivory)] border-t border-[var(--cs-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl space-y-2 mb-12">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Client Reflections
            </p>
            <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
              Trusted Across South Carolina’s Premier Celebrations
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {APPROVED_TESTIMONIALS.map((t) => (
              <blockquote
                key={t.id}
                className="bg-white border border-[var(--cs-border)] rounded-lg p-7 flex flex-col justify-between space-y-6"
              >
                <p className="text-sm text-[var(--cs-charcoal)] leading-relaxed italic">
                  “{t.quote}”
                </p>
                <footer className="pt-4 border-t border-[var(--cs-border)] space-y-1">
                  <p className="text-sm font-semibold text-[var(--cs-purple)]">{t.author}</p>
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">{t.event}</p>
                </footer>
              </blockquote>
            ))}
          </div>
        </div>
      </section>

      {/* Section 10: Final Consultation Invitation */}
      <section className="py-20 bg-white border-t border-[var(--cs-border)]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center space-y-6">
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
            Begin Planning
          </p>
          <h2 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
            Reserve Your Private Design Consultation
          </h2>
          <p className="text-sm sm:text-base text-[var(--cs-charcoal-muted)] max-w-2xl mx-auto leading-relaxed">
            Meet with our Columbia, South Carolina directors to verify your venue date, explore curated rental pieces, and receive an itemized event production proposal.
          </p>
          <div className="pt-2 flex flex-wrap justify-center gap-4">
            <button
              type="button"
              onClick={() => onOpenBooking()}
              className="px-7 py-3.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer"
            >
              Book a Consultation
            </button>
            <button
              type="button"
              onClick={() => onNavigate('portals')}
              className="px-7 py-3.5 text-sm font-medium text-[var(--cs-purple)] border border-[var(--cs-border-strong)] hover:border-[var(--cs-purple)] rounded-md transition-colors cursor-pointer"
            >
              Access Client & Admin Portals
            </button>
          </div>
        </div>
      </section>

      {/* Portfolio Lightbox Modal */}
      {lightboxItem && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={lightboxItem.title}
          onClick={() => setLightboxItem(null)}
        >
          <div
            className="bg-white rounded-lg max-w-4xl w-full overflow-hidden border border-[var(--cs-border)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--cs-border)]">
              <div>
                <p className="text-xs text-[var(--cs-gold-muted)] font-medium">
                  Verified Portfolio Production · {lightboxItem.location}
                </p>
                <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                  {lightboxItem.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setLightboxItem(null)}
                className="p-2 text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] cursor-pointer"
                aria-label="Close lightbox"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="aspect-[16/10] bg-black overflow-hidden">
              <img
                src={lightboxItem.image}
                alt={lightboxItem.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm text-[var(--cs-charcoal)]">{lightboxItem.caption}</p>
                <p className="text-xs text-[var(--cs-charcoal-muted)]">
                  {lightboxItem.venue} · {lightboxItem.guestCount} Guests · {lightboxItem.servicesUsed.join(' / ')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLightboxItem(null);
                  onOpenBooking();
                }}
                className="px-5 py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md whitespace-nowrap cursor-pointer"
              >
                Inquire About Similar Styling
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
