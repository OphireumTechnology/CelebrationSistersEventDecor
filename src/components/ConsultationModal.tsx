import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarCheck, CheckCircle2, RefreshCw, Search, X } from 'lucide-react';
import { SERVICE_DIVISIONS } from '../data/brandCatalog';
import { apiFetch, readApiJson } from '../lib/apiClient';
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

interface TrackedConsultation {
  referenceCode: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  location: string;
  status: string;
  architecturalStage?: string;
  assignedLeadPlanner: string;
  updatedAt: string;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `cs-booking-${crypto.randomUUID()}`;
  }
  return `cs-booking-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  const [mode, setMode] = useState<'request' | 'track'>('request');
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

  const [trackRef, setTrackRef] = useState('');
  const [trackEmail, setTrackEmail] = useState('');
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingResult, setTrackingResult] = useState<TrackedConsultation | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef<string>(createIdempotencyKey());
  const todayIso = new Date().toISOString().slice(0, 10);

  // Reinitialize all request and tracking state whenever the consultation modal opens (reconciles PR #4).
  useEffect(() => {
    if (!open) return;
    setMode('request');
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
    setTrackRef('');
    setTrackEmail('');
    setTrackingResult(null);
    setTrackingError(null);
    idempotencyKeyRef.current = createIdempotencyKey();
  }, [open, initialServiceId, initialEventType, initialLocation, initialGuestCount, initialNotes]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const invalidateAvailability = () => {
    setIsAvailable(null);
    setAvailabilityMsg(null);
    idempotencyKeyRef.current = createIdempotencyKey();
  };

  const toggleDivision = (id: string) => {
    setSelectedDivisions((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((item) => item !== id) : prev) : [...prev, id],
    );
  };

  const handleCheckAvailability = async () => {
    if (!eventDate) {
      setError('Please select a target event date before verifying availability.');
      return;
    }
    if (eventDate < todayIso) {
      setError('Target event date must be today or in the future.');
      return;
    }
    setCheckingAvail(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/availability?date=${encodeURIComponent(eventDate)}&venue=${encodeURIComponent(venueName.trim())}`,
      );
      const data = await readApiJson<{ available?: boolean; capacityNote?: string; error?: string }>(res);
      if (!res.ok) throw new Error(data.error || 'Unable to verify availability.');
      setIsAvailable(Boolean(data.available));
      setAvailabilityMsg(data.capacityNote || 'Availability verified.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Availability check failed. Please try again.');
    } finally {
      setCheckingAvail(false);
    }
  };

  const submitConsultationRequest = async () => {
    if (submitting) return;
    if (!eventDate) {
      setError('Please select a target event date.');
      return;
    }
    if (eventDate < todayIso) {
      setError('Event date cannot be in the past.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientPhone: clientPhone.trim(),
          eventTitle: (eventTitle || `${clientName} ${eventType}`).trim(),
          eventType,
          serviceDivisionIds: selectedDivisions,
          eventDate,
          location: location.trim(),
          venueName: (venueName || 'Venue To Be Finalized').trim(),
          guestCount: Number(guestCount),
          budgetRange,
          notes: notes.trim(),
          requestConsultation: true,
        }),
      });
      const data = await readApiJson<{ booking?: { referenceCode: string }; error?: string }>(res);
      if (!res.ok || !data.booking?.referenceCode) {
        throw new Error(data.error || 'Could not submit consultation request. Please check your connection and retry.');
      }
      setConfirmedRef(data.booking.referenceCode);
      setTrackRef(data.booking.referenceCode);
      setTrackEmail(clientEmail.trim());
      onSuccess?.(data.booking.referenceCode);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Network interruption while submitting request. Your submission is protected against duplicates — click retry.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitConsultationRequest();
  };

  const handleTrackSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trackRef.trim() || !trackEmail.trim()) return;
    setTrackingLoading(true);
    setTrackingError(null);
    setTrackingResult(null);
    try {
      const res = await apiFetch(
        `/api/bookings/track?referenceCode=${encodeURIComponent(trackRef.trim())}&email=${encodeURIComponent(trackEmail.trim())}`,
      );
      const data = await readApiJson<{ tracking?: TrackedConsultation; error?: string }>(res);
      if (!res.ok || !data.tracking) {
        throw new Error(data.error || 'Unable to locate consultation status.');
      }
      setTrackingResult(data.tracking);
    } catch (err) {
      setTrackingError(err instanceof Error ? err.message : 'Unable to check consultation status.');
    } finally {
      setTrackingLoading(false);
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
                {mode === 'request' ? 'Schedule a Private Consultation' : 'Track Consultation Status'}
              </h2>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                {mode === 'request'
                  ? 'Preliminary inquiry & date verification · No payment required to consult'
                  : 'Verify real-time planning status using your confirmation code and email'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode(mode === 'request' ? 'track' : 'request')}
              className="px-3 py-1.5 text-xs font-medium border border-[var(--cs-border-strong)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              {mode === 'request' ? 'Track Status' : 'New Request'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] rounded-md cursor-pointer"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {mode === 'track' ? (
          <form onSubmit={handleTrackSubmit} className="p-6 sm:p-8 space-y-5">
            {trackingError && (
              <div
                role="alert"
                className="p-3.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-lg"
              >
                {trackingError}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                  Confirmation Reference Code
                </label>
                <input
                  required
                  type="text"
                  value={trackRef}
                  onChange={(e) => setTrackRef(e.target.value)}
                  placeholder="CS-2026-068"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md uppercase tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                  Client Email Address
                </label>
                <input
                  required
                  type="email"
                  value={trackEmail}
                  onChange={(e) => setTrackEmail(e.target.value)}
                  placeholder="you@domain.com"
                  className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={trackingLoading}
              className="px-5 py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
            >
              {trackingLoading ? 'Checking Status...' : 'Look Up Consultation'}
            </button>

            {trackingResult && (
              <div className="p-5 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--cs-purple)] tabular-nums">
                    {trackingResult.referenceCode}
                  </span>
                  <span className="px-2.5 py-1 rounded bg-[var(--cs-purple)] text-white font-semibold">
                    {trackingResult.status}
                  </span>
                </div>
                <p className="text-sm font-semibold text-[var(--cs-charcoal)]">{trackingResult.eventTitle}</p>
                <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                  Date: {trackingResult.eventDate} · Venue: {trackingResult.venueName} ({trackingResult.location})
                </p>
                <p className="text-[var(--cs-charcoal-muted)]">
                  Assigned Lead Planner: {trackingResult.assignedLeadPlanner}
                </p>
              </div>
            )}
          </form>
        ) : confirmedRef ? (
          <div className="p-8 sm:p-10 text-center space-y-5">
            <CheckCircle2 className="w-12 h-12 text-[var(--cs-purple)] mx-auto" />
            <h3 className="font-display text-2xl font-semibold text-[var(--cs-charcoal)]">
              Consultation Request Received
            </h3>
            <p className="text-sm text-[var(--cs-charcoal-muted)] max-w-md mx-auto leading-relaxed">
              Your inquiry has been logged under reference{' '}
              <span className="font-semibold text-[var(--cs-purple)] tabular-nums">{confirmedRef}</span>. Our Columbia, SC lead planner will verify date capacity and reach out to confirm your consultation time.
            </p>
            <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setMode('track')}
                className="px-5 py-2.5 text-xs font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md cursor-pointer"
              >
                Track This Request
              </button>
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
              <div
                role="alert"
                className="p-3.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-lg flex flex-wrap items-center justify-between gap-2"
              >
                <span>{error}</span>
                <button
                  type="button"
                  onClick={submitConsultationRequest}
                  disabled={submitting}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white border border-red-300 text-red-800 hover:bg-red-100 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </button>
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
                  onChange={(e) => {
                    setEventType(e.target.value);
                    invalidateAvailability();
                  }}
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
                  min={todayIso}
                  value={eventDate}
                  onChange={(e) => {
                    setEventDate(e.target.value);
                    invalidateAvailability();
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
                    invalidateAvailability();
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
                aria-live="polite"
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
                className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer disabled:opacity-60"
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
