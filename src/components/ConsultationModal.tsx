import { apiFetch } from '../lib/apiClient';
import { useEffect, useState, type FormEvent } from 'react';
import { CalendarCheck, CheckCircle2, X } from 'lucide-react';
import { SERVICE_DIVISIONS } from '../data/brandCatalog';
import { BrandLogo } from './BrandLogo';

interface ConsultationModalProps {
  open: boolean;
  initialServiceId?: string;
  initialNotes?: string;
  initialEventType?: string;
  initialLocation?: string;
  initialGuestCount?: number;
  onClose: () => void;
  onSuccess?: (referenceCode: string) => void;
}

export function ConsultationModal({
  open,
  initialServiceId,
  initialNotes,
  initialEventType,
  initialLocation,
  initialGuestCount,
  onClose,
  onSuccess,
}: ConsultationModalProps) {
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventType, setEventType] = useState(initialEventType || SERVICE_DIVISIONS[0].title);
  const [selectedDivisions, setSelectedDivisions] = useState<string[]>(
    initialServiceId ? [initialServiceId] : ['wedding-planning'],
  );
  const [eventDate, setEventDate] = useState('');
  const [location, setLocation] = useState(initialLocation || 'Columbia, SC');
  const [venueName, setVenueName] = useState('');
  const [guestCount, setGuestCount] = useState(initialGuestCount || 120);
  const [budgetRange, setBudgetRange] = useState('$15,000 – $25,000');
  const [notes, setNotes] = useState(initialNotes || '');

  const [availabilityMsg, setAvailabilityMsg] = useState<string | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [checkingAvail, setCheckingAvail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedRef, setConfirmedRef] = useState<string | null>(null);

  // Reinitialize request details whenever a new consultation is opened.
  useEffect(() => {
    if (!open) return;
    setClientName('');
    setClientEmail('');
    setClientPhone('');
    setEventTitle('');
    setEventType(initialEventType || SERVICE_DIVISIONS[0].title);
    setSelectedDivisions(initialServiceId ? [initialServiceId] : ['wedding-planning']);
    setEventDate('');
    setLocation(initialLocation || 'Columbia, SC');
    setVenueName('');
    setGuestCount(initialGuestCount || 120);
    setBudgetRange('$15,000 – $25,000');
    setNotes(initialNotes || '');
    setAvailabilityMsg(null);
    setIsAvailable(null);
    setCheckingAvail(false);
    setSubmitting(false);
    setError(null);
    setConfirmedRef(null);
  }, [open, initialServiceId, initialEventType, initialLocation, initialGuestCount, initialNotes]);

  if (!open) return null;

  const toggleDivision = (id: string) => {
    setSelectedDivisions((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((item) => item !== id) : prev) : [...prev, id],
    );
  };

  const handleCheckAvailability = async () => {
    setCheckingAvail(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/availability?date=${encodeURIComponent(eventDate)}&venue=${encodeURIComponent(venueName)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to verify availability.');
      setIsAvailable(data.available);
      setAvailabilityMsg(data.capacityNote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Availability check failed.');
    } finally {
      setCheckingAvail(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName,
          clientEmail,
          clientPhone,
          eventTitle: eventTitle || `${clientName} ${eventType}`,
          eventType,
          serviceDivisionIds: selectedDivisions,
          eventDate,
          location,
          venueName: venueName || 'Venue To Be Finalized',
          guestCount: Number(guestCount),
          budgetRange,
          notes,
          requestConsultation: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit consultation request.');
      setConfirmedRef(data.booking.referenceCode);
      onSuccess?.(data.booking.referenceCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission error.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Request Event Consultation"
    >
      <div className="bg-white border border-[var(--cs-border)] rounded-xl max-w-3xl w-full max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-[var(--cs-border)] px-6 py-4 flex items-center justify-between gap-4 z-10">
          <div className="flex items-center gap-3">
            <BrandLogo heightClass="h-9" />
            <div>
              <h2 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                Schedule a Private Consultation
              </h2>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                Preliminary inquiry & date verification · No payment required to consult
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] rounded-md cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {confirmedRef ? (
          <div className="p-8 sm:p-10 text-center space-y-5">
            <CheckCircle2 className="w-12 h-12 text-[var(--cs-purple)] mx-auto" />
            <h3 className="font-display text-2xl font-semibold text-[var(--cs-charcoal)]">
              Consultation Request Received
            </h3>
            <p className="text-sm text-[var(--cs-charcoal-muted)] max-w-md mx-auto leading-relaxed">
              Your inquiry has been logged under reference{' '}
              <span className="font-semibold text-[var(--cs-purple)] tabular-nums">{confirmedRef}</span>. Our Columbia, SC lead planner will verify date capacity and reach out to confirm your consultation time.
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
              >
                Return to Studio
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-6">
            {error && (
              <div className="p-3.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-lg">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Full Name</label>
                <input
                  required
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Jordan & Camille Mercer"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md focus:border-[var(--cs-purple)] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Email Address</label>
                <input
                  required
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  placeholder="you@domain.com"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md focus:border-[var(--cs-purple)] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Phone Number</label>
                <input
                  required
                  type="tel"
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder="(803) 555-0148"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md focus:border-[var(--cs-purple)] outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Celebration Title</label>
                <input
                  required
                  type="text"
                  value={eventTitle}
                  onChange={(e) => setEventTitle(e.target.value)}
                  placeholder="Autumn Estate Wedding Reception"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md focus:border-[var(--cs-purple)] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Primary Category</label>
                <select
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md bg-white focus:border-[var(--cs-purple)] outline-none"
                >
                  {SERVICE_DIVISIONS.map((div) => (
                    <option key={div.id} value={div.title}>
                      {div.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Target Event Date</label>
                <input
                  required
                  type="date"
                  value={eventDate}
                  onChange={(e) => {
                    setEventDate(e.target.value);
                    setIsAvailable(null);
                    setAvailabilityMsg(null);
                  }}
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Venue (or Preferred City)</label>
                <input
                  required
                  type="text"
                  value={venueName}
                  onChange={(e) => {
                    setVenueName(e.target.value);
                    setIsAvailable(null);
                    setAvailabilityMsg(null);
                  }}
                  placeholder="Lace House Gardens"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>
              <button
                type="button"
                onClick={handleCheckAvailability}
                disabled={checkingAvail}
                className="px-4 py-2.5 text-xs font-medium border border-[var(--cs-gold)] text-[var(--cs-charcoal)] hover:bg-[var(--cs-gold-soft)] rounded-md flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <CalendarCheck className="w-4 h-4 text-[var(--cs-gold)]" />
                {checkingAvail ? 'Verifying...' : 'Verify Date Availability'}
              </button>
            </div>

            {availabilityMsg && (
              <div
                className={`p-3 rounded-md text-xs border ${
                  isAvailable
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                {availabilityMsg}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Location</label>
                <input
                  required
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Estimated Guests</label>
                <input
                  required
                  type="number"
                  min={10}
                  max={2000}
                  value={guestCount}
                  onChange={(e) => setGuestCount(Number(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">Investment Range</label>
                <select
                  value={budgetRange}
                  onChange={(e) => setBudgetRange(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md bg-white"
                >
                  <option>$3,500 – $7,500</option>
                  <option>$7,500 – $15,000</option>
                  <option>$15,000 – $25,000</option>
                  <option>$25,000 – $45,000</option>
                  <option>$45,000+</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-2">
                Select Service Divisions of Interest
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {SERVICE_DIVISIONS.map((div) => {
                  const selected = selectedDivisions.includes(div.id);
                  return (
                    <button
                      key={div.id}
                      type="button"
                      onClick={() => toggleDivision(div.id)}
                      className={`px-3 py-2 text-left text-xs rounded-md border transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[var(--cs-purple-soft)] border-[var(--cs-purple)] text-[var(--cs-purple)] font-medium'
                          : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal-muted)] hover:border-[var(--cs-gold)]'
                      }`}
                    >
                      {div.number}. {div.shortTitle}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                Vision, Palette & Planning Notes
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Share preferred floral aesthetic, colors, special cultural traditions, or corporate staging needs..."
                className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-[var(--cs-border)]">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 text-xs font-medium text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-charcoal)] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer"
              >
                {submitting ? 'Submitting Inquiry...' : 'Request Consultation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
