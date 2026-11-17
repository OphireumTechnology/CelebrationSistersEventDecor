import { useState } from 'react';
import { MapPin, X } from 'lucide-react';
import {
  PORTFOLIO_ITEMS,
  SERVICE_LOCATIONS,
  type PortfolioItem,
} from '../data/brandCatalog';

interface PortfolioAndAboutViewProps {
  onOpenBooking: () => void;
}

const GENERAL_FAQS = [
  {
    q: 'Where is Celebration Sisters Event Decor located, and where do you travel?',
    a: 'Our design studio and rental warehouse are headquartered in Columbia, South Carolina. We produce events throughout Lexington, Lake Murray, Irmo, Charleston, Greenville, and Charlotte.',
  },
  {
    q: 'Are quotes itemized or bundled?',
    a: 'All proposals include itemized line items across planning, floral decor, lighting, entertainment, and rentals, plus transparent version history and deposit milestones inside your Client Portal.',
  },
  {
    q: 'How does the AI Event Concept Studio differ from your verified portfolio?',
    a: 'Our Portfolio showcases real photographs from events we have produced. The AI Concept Studio generates clearly labeled conceptual mood boards and palette proposals to help align your vision prior to human designer approval.',
  },
];

export function PortfolioAndAboutView({ onOpenBooking }: PortfolioAndAboutViewProps) {
  const [filter, setFilter] = useState<string>('All');
  const [selectedPhoto, setSelectedPhoto] = useState<PortfolioItem | null>(null);

  const items = filter === 'All' ? PORTFOLIO_ITEMS : PORTFOLIO_ITEMS.filter((p) => p.category === filter);

  return (
    <div className="bg-white text-[var(--cs-charcoal)]">
      {/* Portfolio Gallery */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20 space-y-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-[var(--cs-border)] pb-8">
          <div className="space-y-2 max-w-2xl">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Authorized Event Portfolio
            </p>
            <h1 className="font-display text-3xl sm:text-5xl font-semibold text-[var(--cs-purple)]">
              Timeless Rooms, Thoughtfully Orchestrated
            </h1>
            <p className="text-sm text-[var(--cs-charcoal-muted)]">
              Every photograph below represents verified Celebration Sisters event styling and production—distinct from AI-generated conceptual previews.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 bg-[var(--cs-ivory)] border border-[var(--cs-border)] p-1 rounded-lg">
            {['All', 'Weddings', 'Social & Milestones', 'Corporate & Brand', 'Lighting & Lounge'].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setFilter(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  filter === cat ? 'bg-[var(--cs-purple)] text-white' : 'text-[var(--cs-charcoal-muted)]'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((item) => (
            <article
              key={item.id}
              onClick={() => setSelectedPhoto(item)}
              className="bg-white border border-[var(--cs-border)] hover:border-[var(--cs-gold)] rounded-lg overflow-hidden cursor-pointer group transition-colors"
            >
              <div className="aspect-[4/3] overflow-hidden bg-[var(--cs-ivory)]">
                <img
                  src={item.image}
                  alt={item.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"
                />
              </div>
              <div className="p-5 space-y-2">
                <p className="text-xs text-[var(--cs-charcoal-muted)]">
                  {item.category} · {item.location} · <span className="tabular-nums">{item.guestCount}</span> Guests
                </p>
                <h2 className="font-display text-lg font-semibold text-[var(--cs-purple)]">{item.title}</h2>
                <p className="text-xs text-[var(--cs-charcoal-muted)] leading-relaxed">{item.caption}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* About & Service Locations */}
      <section className="bg-[var(--cs-ivory)] border-y border-[var(--cs-border)] py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12">
          <div className="lg:col-span-6 space-y-4">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              About Celebration Sisters
            </p>
            <h2 className="font-display text-3xl font-semibold text-[var(--cs-purple)]">
              Founded in Columbia, South Carolina on Quiet Hospitality
            </h2>
            <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
              Founded by sisters dedicated to purposeful celebration, our studio pairs editorial floral and tablescape design with enterprise-grade coordination. From private estate weddings to corporate summits, we believe great events feel effortless to the host because every operational cue is engineered behind the scenes.
            </p>
            <button
              type="button"
              onClick={onOpenBooking}
              className="mt-2 px-6 py-3 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
            >
              Meet With Our Columbia Directors
            </button>
          </div>

          <div className="lg:col-span-6 bg-white border border-[var(--cs-border)] rounded-lg p-7 space-y-4">
            <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
              Regional Service Locations
            </h3>
            <div className="divide-y divide-[var(--cs-border)]">
              {SERVICE_LOCATIONS.map((loc) => (
                <div key={loc.city} className="py-3 flex items-start gap-3">
                  <MapPin className="w-4 h-4 text-[var(--cs-gold)] shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-[var(--cs-charcoal)]">{loc.city}</p>
                    <p className="text-xs text-[var(--cs-charcoal-muted)]">{loc.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* FAQs */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-6">
        <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-purple)]">
          Frequently Asked Questions
        </h2>
        <div className="space-y-4">
          {GENERAL_FAQS.map((faq) => (
            <div key={faq.q} className="border border-[var(--cs-border)] rounded-lg p-6 space-y-2">
              <h3 className="text-sm font-semibold text-[var(--cs-purple)]">{faq.q}</h3>
              <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">{faq.a}</p>
            </div>
          ))}
        </div>
      </section>

      {selectedPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div className="bg-white rounded-lg max-w-3xl w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[var(--cs-border)] flex items-center justify-between">
              <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">{selectedPhoto.title}</h3>
              <button type="button" onClick={() => setSelectedPhoto(null)} className="p-1.5 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <img src={selectedPhoto.image} alt={selectedPhoto.title} referrerPolicy="no-referrer" className="w-full aspect-[4/3] object-cover" />
            <div className="p-6 text-sm text-[var(--cs-charcoal-muted)]">{selectedPhoto.caption}</div>
          </div>
        </div>
      )}
    </div>
  );
}
