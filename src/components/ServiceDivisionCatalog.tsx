import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { SERVICE_DIVISIONS, type ServiceDivision } from '../data/brandCatalog';

interface ServiceDivisionCatalogProps {
  selectedServiceId: string | null;
  onSelectService: (id: string | null) => void;
  onOpenBooking: (serviceId: string) => void;
}

const CATEGORIES = [
  'All 12 Divisions',
  'Planning & Milestones',
  'Design & Production',
  'Entertainment & Logistics',
] as const;

export function ServiceDivisionCatalog({
  selectedServiceId,
  onSelectService,
  onOpenBooking,
}: ServiceDivisionCatalogProps) {
  const [categoryFilter, setCategoryFilter] = useState<(typeof CATEGORIES)[number]>('All 12 Divisions');
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  const selectedService: ServiceDivision | undefined = selectedServiceId
    ? SERVICE_DIVISIONS.find((s) => s.id === selectedServiceId)
    : undefined;

  if (selectedService) {
    const related = SERVICE_DIVISIONS.filter((s) => selectedService.relatedIds.includes(s.id));

    return (
      <div className="bg-white text-[var(--cs-charcoal)]">
        {/* Breadcrumb Back Bar */}
        <div className="bg-[var(--cs-ivory)] border-b border-[var(--cs-border)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => onSelectService(null)}
              className="inline-flex items-center gap-2 text-xs font-medium text-[var(--cs-purple)] hover:underline cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              All 12 Event Service Divisions
            </button>
            <span className="text-xs text-[var(--cs-charcoal-muted)]">
              Division {selectedService.number} · {selectedService.category}
            </span>
          </div>
        </div>

        {/* Reusable Configuration-Driven Service Hero */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-18 grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center space-y-5">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Division {selectedService.number} · {selectedService.category}
            </p>
            <h1 className="font-display text-3xl sm:text-5xl font-semibold text-[var(--cs-purple)] leading-tight">
              {selectedService.title}
            </h1>
            <p className="text-base text-[var(--cs-charcoal)] font-medium leading-relaxed">
              {selectedService.tagline}
            </p>
            <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
              {selectedService.description}
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => onOpenBooking(selectedService.id)}
                className="px-6 py-3 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer"
              >
                Request Consultation for {selectedService.shortTitle}
              </button>
              <span className="text-xs text-[var(--cs-charcoal-muted)]">
                Pricing: {selectedService.startingGuidance}
              </span>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="h-full min-h-[320px] rounded-lg overflow-hidden border border-[var(--cs-border)] bg-[var(--cs-ivory)]">
              <img
                src={selectedService.heroImage}
                alt={selectedService.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </section>

        {/* Inclusions & Optional Enhancements */}
        <section className="bg-[var(--cs-ivory)] border-y border-[var(--cs-border)] py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-2 gap-10">
            <div className="bg-white border border-[var(--cs-border)] rounded-lg p-7 space-y-4">
              <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                Core Division Inclusions
              </h2>
              <ul className="space-y-3 text-sm text-[var(--cs-charcoal)]">
                {selectedService.inclusions.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <Check className="w-4 h-4 text-[var(--cs-gold)] shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white border border-[var(--cs-border)] rounded-lg p-7 space-y-4">
              <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                Optional Bespoke Enhancements
              </h2>
              <ul className="space-y-3 text-sm text-[var(--cs-charcoal)]">
                {selectedService.enhancements.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--cs-gold)] shrink-0 mt-2" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Packages & FAQs */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 grid grid-cols-1 lg:grid-cols-12 gap-12">
          <div className="lg:col-span-6 space-y-6">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-purple)]">
              Package Frameworks
            </h2>
            <div className="space-y-4">
              {selectedService.packages.map((pkg) => (
                <div key={pkg.name} className="border border-[var(--cs-border)] rounded-lg p-6 space-y-3 bg-white">
                  <p className="text-xs text-[var(--cs-gold-muted)] font-medium">{pkg.audience}</p>
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">{pkg.name}</h3>
                  <p className="text-sm text-[var(--cs-charcoal-muted)]">{pkg.summary}</p>
                  <div className="pt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--cs-charcoal)]">
                    {pkg.highlights.map((h, i) => (
                      <span key={h}>
                        {i > 0 && <span className="mr-4 text-[var(--cs-taupe)]">·</span>}
                        {h}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-6 space-y-6">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-purple)]">
              Division Questions
            </h2>
            <div className="divide-y divide-[var(--cs-border)] border-y border-[var(--cs-border)]">
              {selectedService.faqs.map((faq, idx) => {
                const isOpen = openFaqIndex === idx;
                return (
                  <div key={faq.q} className="py-4">
                    <button
                      type="button"
                      onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                      className="w-full flex items-center justify-between gap-4 text-left text-sm font-semibold text-[var(--cs-charcoal)] cursor-pointer"
                    >
                      <span>{faq.q}</span>
                      {isOpen ? (
                        <ChevronUp className="w-4 h-4 text-[var(--cs-purple)] shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-[var(--cs-charcoal-muted)] shrink-0" />
                      )}
                    </button>
                    {isOpen && (
                      <p className="mt-2.5 text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                        {faq.a}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Related Divisions */}
        <section className="bg-[var(--cs-ivory)] border-t border-[var(--cs-border)] py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
            <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
              Complementary Service Divisions
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {related.map((rel) => (
                <button
                  key={rel.id}
                  type="button"
                  onClick={() => {
                    onSelectService(rel.id);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="text-left bg-white border border-[var(--cs-border)] hover:border-[var(--cs-gold)] rounded-lg p-5 space-y-2 transition-colors cursor-pointer"
                >
                  <p className="text-xs text-[var(--cs-gold-muted)] font-medium">
                    {rel.number} · {rel.category}
                  </p>
                  <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">{rel.title}</h3>
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">{rel.tagline}</p>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }

  // All 12 Divisions Directory
  const filtered =
    categoryFilter === 'All 12 Divisions'
      ? SERVICE_DIVISIONS
      : SERVICE_DIVISIONS.filter((s) => s.category === categoryFilter);

  return (
    <div className="bg-white text-[var(--cs-charcoal)] py-16 lg:py-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-[var(--cs-border)] pb-8">
          <div className="space-y-3 max-w-2xl">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Complete Service Ecosystem
            </p>
            <h1 className="font-display text-3xl sm:text-5xl font-semibold text-[var(--cs-purple)]">
              Twelve Luxury Event Divisions
            </h1>
            <p className="text-sm sm:text-base text-[var(--cs-charcoal-muted)] leading-relaxed">
              Select any division below to inspect inclusions, enhancement options, package frameworks, and schedule a private consultation.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5 bg-[var(--cs-ivory)] border border-[var(--cs-border)] p-1 rounded-lg">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  categoryFilter === cat
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
          {filtered.map((div) => (
            <article
              key={div.id}
              onClick={() => {
                onSelectService(div.id);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="group bg-white border border-[var(--cs-border)] hover:border-[var(--cs-gold)] rounded-lg overflow-hidden flex flex-col cursor-pointer transition-colors"
            >
              <div className="aspect-[4/3] overflow-hidden bg-[var(--cs-ivory)]">
                <img
                  src={div.heroImage}
                  alt={div.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
              </div>
              <div className="p-6 flex-1 flex flex-col justify-between space-y-4">
                <div className="space-y-2">
                  <p className="text-xs text-[var(--cs-gold-muted)] font-medium">
                    {div.number} · {div.category}
                  </p>
                  <h2 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                    {div.title}
                  </h2>
                  <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                    {div.tagline}
                  </p>
                </div>
                <div className="pt-2 flex items-center justify-between border-t border-[var(--cs-border)]/70">
                  <span className="text-xs font-medium text-[var(--cs-purple)] inline-flex items-center gap-1.5">
                    View Division
                    <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs text-[var(--cs-charcoal-muted)]">
                    {div.inclusions.length} Inclusions
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
