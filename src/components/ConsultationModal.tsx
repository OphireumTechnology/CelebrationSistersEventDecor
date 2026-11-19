import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Video,
  X,
} from 'lucide-react';
import { SERVICE_DIVISIONS } from '../data/brandCatalog';
import { apiFetch, readApiJson } from '../lib/apiClient';
import type { ConsultationMethod, PreferredContactMethod } from '../types/domain';
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

interface ComputedSlot {
  slotId: string;
  plannerId: string;
  plannerName: string;
  dateLocal: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  displayLabel: string;
  studioDisplayLabel: string;
  available: boolean;
  unavailableReason?: string;
  allowedMethods: ConsultationMethod[];
}

interface DayAvailability {
  date: string;
  studioTimezone: string;
  clientTimezone: string;
  isBlackout: boolean;
  blackoutReason?: string;
  isStudioOpen: boolean;
  availableCount: number;
  slots: ComputedSlot[];
}

interface AvailabilityResponse {
  studioTimezone: string;
  clientTimezone: string;
  supportedTimezones: string[];
  planners: Array<{ id: string; name: string; role: string }>;
  days: DayAvailability[];
  error?: string;
}

interface ConfirmedConsultationResult {
  referenceCode: string;
  accessToken?: string;
  clientWindow: string;
  studioWindow: string;
  plannerName: string;
  methodLabel: string;
  status: string;
  emailConfigured: boolean;
  emailReason: string;
  outboxQueued: number;
}

interface ManagedProposalSummary {
  version: number;
  totalAmount: number;
  discountAmount: number;
  itemCount: number;
  createdAt: string;
  clientDecision: string;
  crmStage: string;
}

interface ManagedConsultation {
  id: string;
  referenceCode: string;
  eventTitle: string;
  eventType: string;
  eventTheme?: string;
  eventDate: string;
  guestCount?: number;
  budgetRange?: string;
  venueName: string;
  location: string;
  clientPhone?: string;
  preferredContactMethod?: PreferredContactMethod;
  notes?: string;
  method: ConsultationMethod;
  methodLabel: string;
  status: string;
  crmStage: string;
  assignedPlannerId: string;
  assignedPlannerName: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  clientTimezone: string;
  clientWindow: string;
  studioWindow: string;
  rescheduleCount: number;
  accessTokenExpiresAt?: string;
  canReschedule: boolean;
  canCancel: boolean;
  proposalSummary?: ManagedProposalSummary;
  updatedAt: string;
}

interface LegacyTrackedBooking {
  referenceCode: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  location: string;
  status: string;
  assignedLeadPlanner: string;
  updatedAt: string;
}

const WIZARD_STEPS = [
  { num: 1, title: 'Event Discovery' },
  { num: 2, title: 'Schedule' },
  { num: 3, title: 'Your Details' },
  { num: 4, title: 'Review & Confirm' },
] as const;

const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time (Columbia, SC · ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Phoenix', label: 'Arizona (MST)' },
  { value: 'UTC', label: 'UTC' },
];

const METHOD_OPTIONS: Array<{
  id: ConsultationMethod;
  title: string;
  subtitle: string;
  icon: typeof Video;
}> = [
  {
    id: 'video',
    title: 'Private Video Studio',
    subtitle: '45 min · HD screen-share moodboards & floorplans',
    icon: Video,
  },
  {
    id: 'in_person_columbia',
    title: 'In-Person · Columbia, SC',
    subtitle: '45 min · Tactile linen, floral & crystal review',
    icon: MapPin,
  },
  {
    id: 'phone',
    title: 'Executive Phone Call',
    subtitle: '45 min · Direct strategy call with lead planner',
    icon: Phone,
  },
];

function createKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function detectClientTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TIMEZONE_OPTIONS.some((t) => t.value === tz)) return tz;
  } catch {
    // Fallback to studio timezone
  }
  return 'America/New_York';
}

function formatShortDayLabel(dateIso: string): { weekday: string; dayNum: string; month: string } {
  const dt = new Date(`${dateIso}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(dt),
    dayNum: new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' }).format(dt),
    month: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(dt),
  };
}

function formatMethodLabel(method: ConsultationMethod): string {
  if (method === 'in_person_columbia') return 'In-Person (Columbia, SC Studio)';
  if (method === 'phone') return 'Executive Phone Consultation';
  return 'Private Video Consultation';
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
  const [mode, setMode] = useState<'book' | 'manage'>('book');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: Event Discovery
  const [eventType, setEventType] = useState(initialEventType || SERVICE_DIVISIONS[0].title);
  const [eventTitle, setEventTitle] = useState('');
  const [eventTheme, setEventTheme] = useState('');
  const [selectedDivisions, setSelectedDivisions] = useState<string[]>(
    initialServiceId ? [initialServiceId] : ['wedding-planning'],
  );
  const [eventDate, setEventDate] = useState('');
  const [guestCount, setGuestCount] = useState(initialGuestCount || 120);
  const [budgetRange, setBudgetRange] = useState('$15,000 – $25,000');
  const [location, setLocation] = useState(initialLocation || 'Columbia, SC');
  const [venueName, setVenueName] = useState('');

  // Step 2: Consultation Scheduling
  const [method, setMethod] = useState<ConsultationMethod>('video');
  const [clientTimezone, setClientTimezone] = useState<string>(detectClientTimezone);
  const [availabilityDays, setAvailabilityDays] = useState<DayAvailability[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [selectedDayIso, setSelectedDayIso] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<ComputedSlot | null>(null);
  const [holdExpiresAt, setHoldExpiresAt] = useState<string | null>(null);

  // Step 3: Client Details & Consent
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [preferredContactMethod, setPreferredContactMethod] = useState<PreferredContactMethod>('email');
  const [notes, setNotes] = useState(initialNotes || '');
  const [privacyConsent, setPrivacyConsent] = useState(false);

  // Step 4 & Submission
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedConsultationResult | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  // Manage / Track Appointment state
  const [manageMode, setManageMode] = useState<'consultation' | 'legacy'>('consultation');
  const [trackRef, setTrackRef] = useState('');
  const [trackToken, setTrackToken] = useState('');
  const [trackEmail, setTrackEmail] = useState('');
  const [manageLoading, setManageLoading] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [manageMessage, setManageMessage] = useState<string | null>(null);
  const [managedConsultation, setManagedConsultation] = useState<ManagedConsultation | null>(null);
  const [legacyTracking, setLegacyTracking] = useState<LegacyTrackedBooking | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleDays, setRescheduleDays] = useState<DayAvailability[]>([]);
  const [rescheduleDayIso, setRescheduleDayIso] = useState('');
  const [rescheduleSlot, setRescheduleSlot] = useState<ComputedSlot | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [editPhone, setEditPhone] = useState('');
  const [editPreferredContact, setEditPreferredContact] = useState<PreferredContactMethod>('email');
  const [editEventTheme, setEditEventTheme] = useState('');
  const [editVenueName, setEditVenueName] = useState('');
  const [editGuestCount, setEditGuestCount] = useState(120);
  const [editNotes, setEditNotes] = useState('');
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  const idempotencyKeyRef = useRef<string>(createKey('cs-consult'));
  const holderKeyRef = useRef<string>(createKey('cs-hold'));
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const todayIso = new Date().toISOString().slice(0, 10);

  const fetchAvailability = useCallback(
    async (tz: string, consultationMethod: ConsultationMethod, excludeId?: string) => {
      setAvailabilityLoading(true);
      setAvailabilityError(null);
      try {
        const params = new URLSearchParams({
          startDate: todayIso,
          days: '14',
          timezone: tz,
          method: consultationMethod,
        });
        if (excludeId) params.set('excludeConsultationId', excludeId);
        const res = await apiFetch(`/api/consultations/availability?${params.toString()}`);
        const data = await readApiJson<AvailabilityResponse>(res);
        if (!res.ok || !Array.isArray(data.days)) {
          throw new Error(data.error || 'Unable to load studio consultation availability.');
        }
        return data.days;
      } catch (err) {
        setAvailabilityError(err instanceof Error ? err.message : 'Unable to load availability.');
        return [];
      } finally {
        setAvailabilityLoading(false);
      }
    },
    [todayIso],
  );

  // Reset state whenever the modal opens
  useEffect(() => {
    if (!open) return;
    setMode('book');
    setStep(1);
    setEventType(initialEventType || SERVICE_DIVISIONS[0].title);
    setEventTitle('');
    setEventTheme('');
    setSelectedDivisions(initialServiceId ? [initialServiceId] : ['wedding-planning']);
    setEventDate('');
    setGuestCount(initialGuestCount || 120);
    setBudgetRange('$15,000 – $25,000');
    setLocation(initialLocation || 'Columbia, SC');
    setVenueName('');
    setMethod('video');
    setClientTimezone(detectClientTimezone());
    setSelectedSlot(null);
    setHoldExpiresAt(null);
    setClientName('');
    setClientEmail('');
    setClientPhone('');
    setPreferredContactMethod('email');
    setNotes(initialNotes || '');
    setPrivacyConsent(false);
    setSubmitting(false);
    setError(null);
    setConfirmed(null);
    setCopiedToken(false);
    setTrackRef('');
    setTrackToken('');
    setTrackEmail('');
    setManageError(null);
    setManageMessage(null);
    setManagedConsultation(null);
    setLegacyTracking(null);
    setRescheduleOpen(false);
    setShowCancelConfirm(false);
    setEditDetailsOpen(false);
    setShowRevokeConfirm(false);
    idempotencyKeyRef.current = createKey('cs-consult');
    holderKeyRef.current = createKey('cs-hold');
    requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, [open, initialServiceId, initialEventType, initialLocation, initialGuestCount, initialNotes]);

  // Load real-time availability whenever user is on Step 2 or switches method/timezone
  useEffect(() => {
    if (!open || mode !== 'book' || step !== 2) return;
    let active = true;
    fetchAvailability(clientTimezone, method).then((days) => {
      if (!active) return;
      setAvailabilityDays(days);
      setSelectedDayIso((prev) => {
        if (prev && days.some((d) => d.date === prev)) return prev;
        const firstOpen = days.find((d) => d.availableCount > 0) || days[0];
        return firstOpen?.date || '';
      });
    });
    return () => {
      active = false;
    };
  }, [open, mode, step, clientTimezone, method, fetchAvailability]);

  // Keyboard Escape handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const activeDay = useMemo(
    () => availabilityDays.find((d) => d.date === selectedDayIso) || availabilityDays[0] || null,
    [availabilityDays, selectedDayIso],
  );

  if (!open) return null;

  const toggleDivision = (id: string) => {
    setSelectedDivisions((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((item) => item !== id) : prev) : [...prev, id],
    );
  };

  const validateStep1 = (): string | null => {
    if (!eventDate) return 'Please choose your target event date.';
    if (eventDate < todayIso) return 'Target event date must be today or in the future.';
    if (!location.trim()) return 'Please specify your event city or location.';
    if (Number(guestCount) < 10) return 'Estimated guest count must be at least 10.';
    if (selectedDivisions.length === 0) return 'Please select at least one service division.';
    return null;
  };

  const validateStep2 = (): string | null => {
    if (!selectedSlot) return 'Please select an available consultation date and time slot.';
    return null;
  };

  const validateStep3 = (): string | null => {
    if (clientName.trim().length < 2) return 'Please enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail.trim())) return 'Please enter a valid email address.';
    if (clientPhone.trim().length < 7) return 'Please enter a valid phone number.';
    if (!privacyConsent) return 'Please confirm our privacy notice before proceeding.';
    return null;
  };

  const handleNextStep = async () => {
    setError(null);
    if (step === 1) {
      const msg = validateStep1();
      if (msg) {
        setError(msg);
        return;
      }
      setStep(2);
      return;
    }

    if (step === 2) {
      const msg = validateStep2();
      if (msg || !selectedSlot) {
        setError(msg || 'Please choose a time slot.');
        return;
      }
      // Reserve a temporary 10-minute slot hold so no one books it while user completes Step 3–4
      try {
        const res = await apiFetch('/api/consultations/holds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plannerId: selectedSlot.plannerId,
            startUtc: selectedSlot.startUtc,
            method,
            holderKey: holderKeyRef.current,
          }),
        });
        const data = await readApiJson<{ hold?: { expiresAt: string }; error?: string }>(res);
        if (!res.ok) {
          setError(data.error || 'That time slot was just reserved. Please select another available window.');
          setSelectedSlot(null);
          const refreshed = await fetchAvailability(clientTimezone, method);
          setAvailabilityDays(refreshed);
          return;
        }
        setHoldExpiresAt(data.hold?.expiresAt || null);
      } catch {
        // Proceed — final server validation on POST /api/consultations remains authoritative
      }
      setStep(3);
      return;
    }

    if (step === 3) {
      const msg = validateStep3();
      if (msg) {
        setError(msg);
        return;
      }
      setStep(4);
    }
  };

  const handleConfirmBooking = async (e?: FormEvent) => {
    e?.preventDefault();
    if (submitting || !selectedSlot) return;

    const s1 = validateStep1();
    const s3 = validateStep3();
    if (s1 || s3) {
      setError(s1 || s3);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/consultations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          eventType,
          eventTitle: (eventTitle || `${clientName.trim()} ${eventType}`).trim(),
          eventTheme: eventTheme.trim(),
          serviceDivisionIds: selectedDivisions,
          eventDate,
          guestCount: Number(guestCount),
          budgetRange,
          location: location.trim(),
          venueName: (venueName || 'Venue To Be Finalized').trim(),
          consultationStartUtc: selectedSlot.startUtc,
          consultationMethod: method,
          plannerId: selectedSlot.plannerId,
          clientTimezone,
          holderKey: holderKeyRef.current,
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientPhone: clientPhone.trim(),
          preferredContactMethod,
          notes: notes.trim(),
          privacyConsentAccepted: true,
        }),
      });

      const data = await readApiJson<{
        consultation?: { referenceCode: string; assignedPlannerName: string; status: string };
        accessToken?: string;
        scheduleDisplay?: { clientWindow: string; studioWindow: string };
        notificationStatus?: {
          provider: { configured: boolean; liveDeliveryEnabled: boolean; reason: string };
          outboxQueued: number;
        };
        suggestedSlots?: ComputedSlot[];
        error?: string;
        code?: string;
      }>(res);

      if (res.status === 409) {
        idempotencyKeyRef.current = createKey('cs-consult');
        setSelectedSlot(null);
        setHoldExpiresAt(null);
        setStep(2);
        setError(
          data.error ||
            'Another client reserved this consultation slot seconds ago. Availability has been refreshed — please select a new time.',
        );
        const refreshed = await fetchAvailability(clientTimezone, method);
        setAvailabilityDays(refreshed);
        return;
      }

      if (res.status === 503) {
        throw new Error(
          data.error ||
            'Our booking database is temporarily unavailable. Your consultation has not been confirmed — please click Retry in a moment (protected against duplicate bookings).',
        );
      }

      if (!res.ok || !data.consultation?.referenceCode) {
        throw new Error(data.error || 'Could not complete consultation booking. Please review your details and retry.');
      }

      const refCode = data.consultation.referenceCode;
      setConfirmed({
        referenceCode: refCode,
        accessToken: data.accessToken,
        clientWindow: data.scheduleDisplay?.clientWindow || selectedSlot.displayLabel,
        studioWindow: data.scheduleDisplay?.studioWindow || selectedSlot.studioDisplayLabel,
        plannerName: data.consultation.assignedPlannerName,
        methodLabel: formatMethodLabel(method),
        status: data.consultation.status,
        emailConfigured: Boolean(
          data.notificationStatus?.provider.configured && data.notificationStatus?.provider.liveDeliveryEnabled,
        ),
        emailReason:
          data.notificationStatus?.provider.reason ||
          'Notification recorded in the studio outbox.',
        outboxQueued: data.notificationStatus?.outboxQueued ?? 0,
      });
      setTrackRef(refCode);
      if (data.accessToken) setTrackToken(data.accessToken);
      setTrackEmail(clientEmail.trim());
      onSuccess?.(refCode);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Network interruption while confirming your consultation. Your submission is protected by idempotency — click Retry.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyToken = async () => {
    if (!confirmed?.accessToken) return;
    try {
      await navigator.clipboard.writeText(confirmed.accessToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2500);
    } catch {
      // Clipboard API unavailable in restricted frames
    }
  };

  const handleLookupAppointment = async (e: FormEvent) => {
    e.preventDefault();
    setManageLoading(true);
    setManageError(null);
    setManageMessage(null);
    setManagedConsultation(null);
    setLegacyTracking(null);
    setRescheduleOpen(false);
    setShowCancelConfirm(false);

    try {
      if (manageMode === 'consultation') {
        const res = await apiFetch(
          `/api/consultations/status?referenceCode=${encodeURIComponent(trackRef.trim())}&accessToken=${encodeURIComponent(trackToken.trim())}`,
        );
        const data = await readApiJson<{ consultation?: ManagedConsultation; error?: string }>(res);
        if (!res.ok || !data.consultation) {
          throw new Error(data.error || 'Unable to verify consultation reference and access token.');
        }
        setManagedConsultation(data.consultation);
        setEditPhone(data.consultation.clientPhone || '');
        setEditPreferredContact(data.consultation.preferredContactMethod || 'email');
        setEditEventTheme(data.consultation.eventTheme || '');
        setEditVenueName(data.consultation.venueName || '');
        setEditGuestCount(data.consultation.guestCount || 120);
        setEditNotes(data.consultation.notes || '');
      } else {
        const res = await apiFetch(
          `/api/bookings/track?referenceCode=${encodeURIComponent(trackRef.trim())}&email=${encodeURIComponent(trackEmail.trim())}`,
        );
        const data = await readApiJson<{ tracking?: LegacyTrackedBooking; error?: string }>(res);
        if (!res.ok || !data.tracking) {
          throw new Error(data.error || 'Unable to locate booking status.');
        }
        setLegacyTracking(data.tracking);
      }
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Status lookup failed.');
    } finally {
      setManageLoading(false);
    }
  };

  const openReschedulePicker = async () => {
    if (!managedConsultation) return;
    setRescheduleOpen(true);
    setShowCancelConfirm(false);
    setRescheduleSlot(null);
    setManageError(null);
    const days = await fetchAvailability(
      managedConsultation.clientTimezone,
      managedConsultation.method,
      managedConsultation.id,
    );
    setRescheduleDays(days);
    const firstOpen = days.find((d) => d.availableCount > 0) || days[0];
    setRescheduleDayIso(firstOpen?.date || '');
  };

  const handleRescheduleSubmit = async () => {
    if (!managedConsultation || !rescheduleSlot) return;
    setManageLoading(true);
    setManageError(null);
    setManageMessage(null);
    try {
      const res = await apiFetch(`/api/consultations/${encodeURIComponent(managedConsultation.id)}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newStartUtc: rescheduleSlot.startUtc,
          plannerId: rescheduleSlot.plannerId,
          accessToken: trackToken.trim(),
          reason: 'Rescheduled by client online',
        }),
      });
      const data = await readApiJson<{
        consultation?: { status: string; startUtc: string; endUtc: string; assignedPlannerName: string; rescheduleCount: number };
        scheduleDisplay?: { clientWindow: string; studioWindow: string };
        error?: string;
      }>(res);
      if (!res.ok || !data.consultation) {
        throw new Error(data.error || 'Unable to reschedule consultation.');
      }
      setManagedConsultation({
        ...managedConsultation,
        status: data.consultation.status,
        startUtc: data.consultation.startUtc,
        endUtc: data.consultation.endUtc,
        assignedPlannerName: data.consultation.assignedPlannerName,
        rescheduleCount: data.consultation.rescheduleCount,
        clientWindow: data.scheduleDisplay?.clientWindow || rescheduleSlot.displayLabel,
        studioWindow: data.scheduleDisplay?.studioWindow || rescheduleSlot.studioDisplayLabel,
      });
      setRescheduleOpen(false);
      setRescheduleSlot(null);
      setManageMessage('Consultation rescheduled successfully. Your previous slot has been released.');
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Reschedule failed.');
    } finally {
      setManageLoading(false);
    }
  };

  const handleCancelSubmit = async () => {
    if (!managedConsultation) return;
    setManageLoading(true);
    setManageError(null);
    setManageMessage(null);
    try {
      const res = await apiFetch(`/api/consultations/${encodeURIComponent(managedConsultation.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: trackToken.trim(),
          reason: cancelReason.trim() || 'Cancelled by client online',
        }),
      });
      const data = await readApiJson<{ consultation?: { status: string }; error?: string }>(res);
      if (!res.ok || !data.consultation) {
        throw new Error(data.error || 'Unable to cancel consultation.');
      }
      setManagedConsultation({
        ...managedConsultation,
        status: data.consultation.status,
        canReschedule: false,
        canCancel: false,
      });
      setShowCancelConfirm(false);
      setManageMessage('Consultation cancelled and time slot released.');
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Cancellation failed.');
    } finally {
      setManageLoading(false);
    }
  };

  const handleUpdateClientDetails = async (e: FormEvent) => {
    e.preventDefault();
    if (!managedConsultation) return;
    setManageLoading(true);
    setManageError(null);
    setManageMessage(null);
    try {
      const res = await apiFetch(`/api/consultations/${encodeURIComponent(managedConsultation.id)}/client-details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: trackToken.trim(),
          clientPhone: editPhone.trim() || undefined,
          preferredContactMethod: editPreferredContact,
          eventTheme: editEventTheme.trim(),
          venueName: editVenueName.trim() || undefined,
          guestCount: Number(editGuestCount),
          notes: editNotes.trim(),
        }),
      });
      const data = await readApiJson<{
        consultation?: {
          clientPhone: string;
          preferredContactMethod: PreferredContactMethod;
          eventTheme?: string;
          venueName: string;
          guestCount: number;
          consultationNotes: string;
          updatedAt: string;
        };
        error?: string;
      }>(res);
      if (!res.ok || !data.consultation) {
        throw new Error(data.error || 'Unable to update consultation contact and event details.');
      }
      setManagedConsultation({
        ...managedConsultation,
        clientPhone: data.consultation.clientPhone,
        preferredContactMethod: data.consultation.preferredContactMethod,
        eventTheme: data.consultation.eventTheme,
        venueName: data.consultation.venueName,
        guestCount: data.consultation.guestCount,
        notes: data.consultation.consultationNotes,
        updatedAt: data.consultation.updatedAt,
      });
      setEditDetailsOpen(false);
      setManageMessage('Your contact details and event requirements have been updated and synced with your planner.');
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Unable to save details.');
    } finally {
      setManageLoading(false);
    }
  };

  const handleRevokeToken = async () => {
    if (!managedConsultation) return;
    setManageLoading(true);
    setManageError(null);
    setManageMessage(null);
    try {
      const res = await apiFetch(`/api/consultations/${encodeURIComponent(managedConsultation.id)}/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: trackToken.trim() }),
      });
      const data = await readApiJson<{ revoked?: boolean; error?: string }>(res);
      if (!res.ok || !data.revoked) {
        throw new Error(data.error || 'Unable to revoke verification token.');
      }
      setShowRevokeConfirm(false);
      setManagedConsultation(null);
      setTrackToken('');
      setManageMessage('Verification token revoked immediately. Contact the studio or sign in to your client account to access this appointment.');
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Token revocation failed.');
    } finally {
      setManageLoading(false);
    }
  };

  const activeRescheduleDay =
    rescheduleDays.find((d) => d.date === rescheduleDayIso) || rescheduleDays[0] || null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Book a Private Consultation"
    >
      <div className="bg-white border border-[var(--cs-border)] rounded-xl max-w-4xl w-full max-h-[94vh] overflow-y-auto shadow-xl">
        {/* Sticky Modal Header */}
        <div className="sticky top-0 bg-white border-b border-[var(--cs-border)] px-5 sm:px-7 py-4 flex items-center justify-between gap-4 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <BrandLogo heightClass="h-9" />
            <div className="min-w-0">
              <h2 className="font-display text-lg sm:text-xl font-semibold text-[var(--cs-purple)] truncate">
                {mode === 'book' ? 'Book a Private Consultation' : 'Manage Your Consultation'}
              </h2>
              <p className="text-xs text-[var(--cs-charcoal-muted)] truncate">
                {mode === 'book'
                  ? 'Columbia, SC Studio · Real-time planner availability · Complimentary initial session'
                  : 'Verify status, reschedule, or cancel with your private confirmation token'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'book' ? 'manage' : 'book');
                setError(null);
                setManageError(null);
              }}
              className="min-h-[40px] px-3 py-2 text-xs font-medium border border-[var(--cs-border-strong)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              {mode === 'book' ? 'Manage / Track' : 'New Consultation'}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] rounded-md cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cs-purple)]"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* MANAGE / TRACK APPOINTMENT MODE */}
        {mode === 'manage' ? (
          <div className="p-5 sm:p-8 space-y-6">
            <div className="flex flex-wrap gap-2 border-b border-[var(--cs-border)] pb-3">
              <button
                type="button"
                onClick={() => {
                  setManageMode('consultation');
                  setManageError(null);
                }}
                className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-md cursor-pointer ${
                  manageMode === 'consultation'
                    ? 'bg-[var(--cs-purple)] text-white'
                    : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] border border-[var(--cs-border)]'
                }`}
              >
                Consultation Appointment (Token)
              </button>
              <button
                type="button"
                onClick={() => {
                  setManageMode('legacy');
                  setManageError(null);
                }}
                className={`min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-md cursor-pointer ${
                  manageMode === 'legacy'
                    ? 'bg-[var(--cs-purple)] text-white'
                    : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] border border-[var(--cs-border)]'
                }`}
              >
                Event Booking Lookup (Email)
              </button>
            </div>

            <form onSubmit={handleLookupAppointment} className="space-y-4">
              {manageError && (
                <div role="alert" className="p-3.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md">
                  {manageError}
                </div>
              )}
              {manageMessage && (
                <div aria-live="polite" className="p-3.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md">
                  {manageMessage}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="manage-ref" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                    Confirmation Reference Code
                  </label>
                  <input
                    id="manage-ref"
                    required
                    type="text"
                    value={trackRef}
                    onChange={(e) => setTrackRef(e.target.value)}
                    placeholder="CS-2026-0068"
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md uppercase tabular-nums"
                  />
                </div>
                {manageMode === 'consultation' ? (
                  <div>
                    <label htmlFor="manage-token" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Private Verification Access Token
                    </label>
                    <input
                      id="manage-token"
                      required
                      type="text"
                      value={trackToken}
                      onChange={(e) => setTrackToken(e.target.value)}
                      placeholder="csa_..."
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label htmlFor="manage-email" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Client Email Address
                    </label>
                    <input
                      id="manage-email"
                      required
                      type="email"
                      value={trackEmail}
                      onChange={(e) => setTrackEmail(e.target.value)}
                      placeholder="you@domain.com"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={manageLoading}
                className="min-h-[44px] px-5 py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-60"
              >
                {manageLoading ? 'Verifying...' : 'Verify & Open Appointment'}
              </button>
            </form>

            {managedConsultation && (
              <div className="p-5 sm:p-6 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--cs-border)] pb-3">
                  <div>
                    <p className="text-xs font-medium text-[var(--cs-gold-muted)] tabular-nums">
                      {managedConsultation.referenceCode} · Status: {managedConsultation.status} · Stage: {managedConsultation.crmStage}
                    </p>
                    <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)] mt-0.5">
                      {managedConsultation.eventTitle}
                    </h3>
                  </div>
                  <span className="text-xs font-semibold text-[var(--cs-purple)]">
                    {managedConsultation.methodLabel}
                  </span>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Scheduled Consultation ({managedConsultation.clientTimezone})</dt>
                    <dd className="font-semibold text-[var(--cs-charcoal)] tabular-nums mt-0.5">
                      {managedConsultation.clientWindow}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Columbia Studio Time (ET)</dt>
                    <dd className="font-medium text-[var(--cs-charcoal)] tabular-nums mt-0.5">
                      {managedConsultation.studioWindow}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Target Event Date & Venue</dt>
                    <dd className="font-medium text-[var(--cs-charcoal)] tabular-nums mt-0.5">
                      {managedConsultation.eventDate} · {managedConsultation.venueName} ({managedConsultation.location})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Assigned Lead Planner</dt>
                    <dd className="font-medium text-[var(--cs-charcoal)] mt-0.5">
                      {managedConsultation.assignedPlannerName}
                    </dd>
                  </div>
                  {managedConsultation.eventTheme && (
                    <div>
                      <dt className="text-[var(--cs-charcoal-muted)]">Event Theme</dt>
                      <dd className="font-medium text-[var(--cs-charcoal)] mt-0.5">{managedConsultation.eventTheme}</dd>
                    </div>
                  )}
                  {managedConsultation.clientPhone && (
                    <div>
                      <dt className="text-[var(--cs-charcoal-muted)]">Contact Preference</dt>
                      <dd className="font-medium text-[var(--cs-charcoal)] mt-0.5 tabular-nums">
                        {managedConsultation.clientPhone} ({(managedConsultation.preferredContactMethod || 'email').toUpperCase()})
                      </dd>
                    </div>
                  )}
                </dl>

                {managedConsultation.proposalSummary && (
                  <div className="p-4 bg-white border border-[var(--cs-gold)]/60 rounded-md space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-[var(--cs-purple)]">
                        Proposal Status · Version {managedConsultation.proposalSummary.version}
                      </span>
                      <span className="font-semibold text-[var(--cs-charcoal)] tabular-nums">
                        ${managedConsultation.proposalSummary.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                      {managedConsultation.proposalSummary.itemCount} line item(s) · Decision:{' '}
                      <span className="font-medium text-[var(--cs-charcoal)]">
                        {managedConsultation.proposalSummary.clientDecision}
                      </span>{' '}
                      · CRM Stage: {managedConsultation.proposalSummary.crmStage}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2.5 pt-2 border-t border-[var(--cs-border)]">
                  {managedConsultation.canReschedule && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditDetailsOpen(false);
                        setShowRevokeConfirm(false);
                        openReschedulePicker();
                      }}
                      className="min-h-[44px] px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                    >
                      Reschedule Consultation
                    </button>
                  )}
                  {managedConsultation.status !== 'Cancelled' && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditDetailsOpen((prev) => !prev);
                        setRescheduleOpen(false);
                        setShowCancelConfirm(false);
                        setShowRevokeConfirm(false);
                      }}
                      className="min-h-[44px] px-4 py-2 text-xs font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md cursor-pointer"
                    >
                      {editDetailsOpen ? 'Close Details Editor' : 'Update Contact & Requirements'}
                    </button>
                  )}
                  {managedConsultation.canCancel && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowCancelConfirm(true);
                        setRescheduleOpen(false);
                        setEditDetailsOpen(false);
                        setShowRevokeConfirm(false);
                      }}
                      className="min-h-[44px] px-4 py-2 text-xs font-medium border border-red-300 text-red-800 hover:bg-red-50 rounded-md cursor-pointer"
                    >
                      Cancel Appointment
                    </button>
                  )}
                  {trackToken.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowRevokeConfirm((prev) => !prev);
                        setRescheduleOpen(false);
                        setEditDetailsOpen(false);
                        setShowCancelConfirm(false);
                      }}
                      className="min-h-[44px] px-3.5 py-2 text-xs font-medium border border-[var(--cs-border-strong)] text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-charcoal)] rounded-md cursor-pointer"
                    >
                      Revoke Access Token
                    </button>
                  )}
                </div>

                {editDetailsOpen && (
                  <form onSubmit={handleUpdateClientDetails} className="p-4 bg-white border border-[var(--cs-border)] rounded-md space-y-3">
                    <p className="text-xs font-semibold text-[var(--cs-purple)]">
                      Update Contact Preferences & Event Requirements
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="manage-edit-phone" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                          Phone Number
                        </label>
                        <input
                          id="manage-edit-phone"
                          type="tel"
                          required
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                        />
                      </div>
                      <div>
                        <label htmlFor="manage-edit-contact" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                          Preferred Contact Method
                        </label>
                        <select
                          id="manage-edit-contact"
                          value={editPreferredContact}
                          onChange={(e) => setEditPreferredContact(e.target.value as PreferredContactMethod)}
                          className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                        >
                          <option value="email">Email</option>
                          <option value="phone">Phone Call</option>
                          <option value="sms">Text / SMS</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="manage-edit-theme" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                          Event Theme / Palette
                        </label>
                        <input
                          id="manage-edit-theme"
                          type="text"
                          value={editEventTheme}
                          onChange={(e) => setEditEventTheme(e.target.value)}
                          placeholder="Candlelit Royal Amethyst & Champagne"
                          className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                        />
                      </div>
                      <div>
                        <label htmlFor="manage-edit-guests" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                          Estimated Guest Count
                        </label>
                        <input
                          id="manage-edit-guests"
                          type="number"
                          min={10}
                          max={5000}
                          value={editGuestCount}
                          onChange={(e) => setEditGuestCount(Number(e.target.value))}
                          className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                        />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="manage-edit-venue" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                        Venue Name
                      </label>
                      <input
                        id="manage-edit-venue"
                        type="text"
                        value={editVenueName}
                        onChange={(e) => setEditVenueName(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                      />
                    </div>
                    <div>
                      <label htmlFor="manage-edit-notes" className="block text-[11px] font-medium text-[var(--cs-charcoal)] mb-1">
                        Updated Inspiration & Event Notes
                      </label>
                      <textarea
                        id="manage-edit-notes"
                        rows={2}
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditDetailsOpen(false)}
                        className="min-h-[44px] px-3.5 py-2 text-xs text-[var(--cs-charcoal-muted)] cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={manageLoading}
                        className="min-h-[44px] px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-50"
                      >
                        {manageLoading ? 'Saving...' : 'Save Updates'}
                      </button>
                    </div>
                  </form>
                )}

                {showRevokeConfirm && (
                  <div className="p-4 bg-white border border-amber-300 rounded-md space-y-2.5 text-xs">
                    <p className="font-semibold text-amber-950">Revoke Private Access Token?</p>
                    <p className="text-[var(--cs-charcoal-muted)]">
                      This immediately invalidates your current token for token-based lookup, rescheduling, and updates. Your consultation remains active in the studio schedule.
                    </p>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowRevokeConfirm(false)}
                        className="min-h-[44px] px-3.5 py-2 text-xs text-[var(--cs-charcoal-muted)] cursor-pointer"
                      >
                        Keep Active
                      </button>
                      <button
                        type="button"
                        disabled={manageLoading}
                        onClick={handleRevokeToken}
                        className="min-h-[44px] px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md cursor-pointer"
                      >
                        {manageLoading ? 'Revoking...' : 'Confirm Revoke Token'}
                      </button>
                    </div>
                  </div>
                )}

                {rescheduleOpen && (
                  <div className="p-4 bg-white border border-[var(--cs-border)] rounded-md space-y-4">
                    <p className="text-xs font-semibold text-[var(--cs-purple)]">
                      Select a New Consultation Slot ({managedConsultation.clientTimezone})
                    </p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {rescheduleDays.map((day) => {
                        const fmt = formatShortDayLabel(day.date);
                        const isSelected = day.date === rescheduleDayIso;
                        const disabled = day.availableCount === 0;
                        return (
                          <button
                            key={day.date}
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              setRescheduleDayIso(day.date);
                              setRescheduleSlot(null);
                            }}
                            className={`min-w-[68px] min-h-[60px] px-2.5 py-2 rounded-md border text-center text-xs shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                              isSelected
                                ? 'bg-[var(--cs-purple)] text-white border-[var(--cs-purple)]'
                                : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal)] hover:border-[var(--cs-gold)]'
                            }`}
                          >
                            <div className="text-[10px] uppercase">{fmt.weekday}</div>
                            <div className="font-semibold tabular-nums">{fmt.month} {fmt.dayNum}</div>
                            <div className="text-[10px] tabular-nums">{day.isBlackout ? 'Closed' : `${day.availableCount} open`}</div>
                          </button>
                        );
                      })}
                    </div>

                    {activeRescheduleDay && (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {activeRescheduleDay.slots.map((slot) => (
                          <button
                            key={slot.slotId}
                            type="button"
                            disabled={!slot.available}
                            onClick={() => setRescheduleSlot(slot)}
                            className={`min-h-[44px] px-3 py-2 rounded-md border text-left text-xs cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                              rescheduleSlot?.slotId === slot.slotId
                                ? 'bg-[var(--cs-purple-soft)] border-[var(--cs-purple)] text-[var(--cs-purple)] font-semibold'
                                : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal)] hover:border-[var(--cs-gold)]'
                            }`}
                          >
                            <div className="tabular-nums font-medium">{slot.displayLabel}</div>
                            <div className="text-[11px] text-[var(--cs-charcoal-muted)] truncate">
                              {slot.available ? slot.plannerName : slot.unavailableReason || 'Reserved'}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setRescheduleOpen(false)}
                        className="min-h-[40px] px-3.5 py-2 text-xs text-[var(--cs-charcoal-muted)] cursor-pointer"
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        disabled={!rescheduleSlot || manageLoading}
                        onClick={handleRescheduleSubmit}
                        className="min-h-[40px] px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer disabled:opacity-50"
                      >
                        {manageLoading ? 'Updating...' : 'Confirm Reschedule'}
                      </button>
                    </div>
                  </div>
                )}

                {showCancelConfirm && (
                  <div className="p-4 bg-white border border-red-200 rounded-md space-y-3">
                    <p className="text-xs font-semibold text-red-900">
                      Confirm Consultation Cancellation
                    </p>
                    <input
                      type="text"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Optional reason (e.g., event date changed)"
                      className="w-full min-h-[44px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowCancelConfirm(false)}
                        className="min-h-[40px] px-3.5 py-2 text-xs text-[var(--cs-charcoal-muted)] cursor-pointer"
                      >
                        Keep Appointment
                      </button>
                      <button
                        type="button"
                        disabled={manageLoading}
                        onClick={handleCancelSubmit}
                        className="min-h-[40px] px-4 py-2 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-md cursor-pointer"
                      >
                        {manageLoading ? 'Cancelling...' : 'Yes, Cancel & Release Slot'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {legacyTracking && (
              <div className="p-5 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg space-y-2 text-xs">
                <p className="font-semibold text-[var(--cs-purple)] tabular-nums">
                  {legacyTracking.referenceCode} · {legacyTracking.status}
                </p>
                <p className="text-sm font-semibold text-[var(--cs-charcoal)]">{legacyTracking.eventTitle}</p>
                <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                  Event Date: {legacyTracking.eventDate} · Venue: {legacyTracking.venueName} ({legacyTracking.location})
                </p>
                <p className="text-[var(--cs-charcoal-muted)]">
                  Assigned Lead Planner: {legacyTracking.assignedLeadPlanner}
                </p>
              </div>
            )}
          </div>
        ) : confirmed ? (
          /* CONFIRMED CONSULTATION SUMMARY (Rendered ONLY after backend persistence succeeds) */
          <div className="p-6 sm:p-10 space-y-6">
            <div className="text-center space-y-2.5">
              <CheckCircle2 className="w-12 h-12 text-[var(--cs-purple)] mx-auto" />
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--cs-gold-muted)]">
                Consultation Confirmed in Studio Schedule
              </p>
              <h3 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-charcoal)]">
                Your Private Consultation Is Reserved
              </h3>
              <p className="text-sm text-[var(--cs-charcoal-muted)] max-w-lg mx-auto">
                Reference <span className="font-semibold text-[var(--cs-purple)] tabular-nums">{confirmed.referenceCode}</span> has been persisted with lead planner{' '}
                <span className="font-medium text-[var(--cs-charcoal)]">{confirmed.plannerName}</span>.
              </p>
            </div>

            <div className="bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <p className="text-[var(--cs-charcoal-muted)]">Consultation Appointment ({clientTimezone})</p>
                <p className="font-semibold text-[var(--cs-purple)] tabular-nums mt-0.5">{confirmed.clientWindow}</p>
              </div>
              <div>
                <p className="text-[var(--cs-charcoal-muted)]">Columbia Studio Time (ET)</p>
                <p className="font-medium text-[var(--cs-charcoal)] tabular-nums mt-0.5">{confirmed.studioWindow}</p>
              </div>
              <div>
                <p className="text-[var(--cs-charcoal-muted)]">Format & Lead Planner</p>
                <p className="font-medium text-[var(--cs-charcoal)] mt-0.5">
                  {confirmed.methodLabel} · {confirmed.plannerName}
                </p>
              </div>
              <div>
                <p className="text-[var(--cs-charcoal-muted)]">Target Event Date</p>
                <p className="font-medium text-[var(--cs-charcoal)] tabular-nums mt-0.5">
                  {eventDate} · {venueName || 'Venue To Be Finalized'} ({location})
                </p>
              </div>
            </div>

            {confirmed.accessToken && (
              <div className="p-4 border border-[var(--cs-gold)] bg-white rounded-lg space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[var(--cs-purple)] inline-flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-[var(--cs-gold)]" />
                    Private Reschedule & Status Verification Token (Shown Once)
                  </p>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    className="min-h-[36px] px-3 py-1.5 text-xs font-medium border border-[var(--cs-border-strong)] rounded hover:bg-[var(--cs-ivory)] inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    {copiedToken ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedToken ? 'Copied' : 'Copy Token'}
                  </button>
                </div>
                <p className="font-mono text-xs bg-[var(--cs-ivory)] px-3 py-2 rounded border border-[var(--cs-border)] break-all select-all">
                  {confirmed.accessToken}
                </p>
                <p className="text-[11px] text-[var(--cs-charcoal-muted)]">
                  Save this token together with <span className="font-semibold tabular-nums">{confirmed.referenceCode}</span> to view status, reschedule, or cancel securely without signing in.
                </p>
              </div>
            )}

            <p className="text-xs text-[var(--cs-charcoal-muted)] text-center">
              {confirmed.emailConfigured
                ? `Confirmation notification queued (${confirmed.outboxQueued} outbox jobs) via Resend.`
                : `Booking saved & ${confirmed.outboxQueued} notification job(s) logged in studio outbox (${confirmed.emailReason}).`}
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setMode('manage');
                  setManageMode('consultation');
                }}
                className="min-h-[44px] px-5 py-2.5 text-xs font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md cursor-pointer"
              >
                Manage / Reschedule Appointment
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] px-6 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
              >
                Return to Studio
              </button>
            </div>
          </div>
        ) : (
          /* 4-STEP CONSULTATION BOOKING WIZARD */
          <div className="p-5 sm:p-8 space-y-6">
            {/* Step Progress Indicator */}
            <nav aria-label="Consultation booking progress" className="border-b border-[var(--cs-border)] pb-4">
              <ol className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {WIZARD_STEPS.map((s) => {
                  const isCurrent = step === s.num;
                  const isDone = step > s.num;
                  return (
                    <li key={s.num}>
                      <button
                        type="button"
                        disabled={s.num > step}
                        aria-current={isCurrent ? 'step' : undefined}
                        onClick={() => {
                          if (s.num < step) {
                            setError(null);
                            setStep(s.num as 1 | 2 | 3 | 4);
                          }
                        }}
                        className={`w-full min-h-[44px] text-left px-3 py-2 rounded-md border text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cs-purple)] ${
                          isCurrent
                            ? 'bg-[var(--cs-purple)] text-white border-[var(--cs-purple)]'
                            : isDone
                              ? 'bg-[var(--cs-ivory)] text-[var(--cs-purple)] border-[var(--cs-border-strong)] cursor-pointer hover:border-[var(--cs-purple)]'
                              : 'bg-white text-[var(--cs-charcoal-muted)] border-[var(--cs-border)] cursor-not-allowed'
                        }`}
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-wider opacity-80 tabular-nums">
                          Step 0{s.num}
                        </span>
                        <span className="font-medium">{s.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>

            {error && (
              <div
                role="alert"
                className="p-3.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md flex flex-wrap items-center justify-between gap-2"
              >
                <span>{error}</span>
                {step === 4 && (
                  <button
                    type="button"
                    onClick={() => handleConfirmBooking()}
                    disabled={submitting}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-white border border-red-300 text-red-800 hover:bg-red-100 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Retry
                  </button>
                )}
              </div>
            )}

            {/* STEP 1: EVENT DISCOVERY */}
            {step === 1 && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-charcoal)]">
                    01. Tell Us About Your Celebration
                  </h3>
                  <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                    Your target event date is kept separate from the consultation date you will schedule next.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="wizard-event-type" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Primary Event Category
                    </label>
                    <select
                      id="wizard-event-type"
                      value={eventType}
                      onChange={(e) => setEventType(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      {SERVICE_DIVISIONS.map((div) => (
                        <option key={div.id} value={div.title}>
                          {div.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="wizard-event-title" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Celebration Title (Optional)
                    </label>
                    <input
                      id="wizard-event-title"
                      type="text"
                      value={eventTitle}
                      onChange={(e) => setEventTitle(e.target.value)}
                      placeholder="Autumn Estate Wedding Reception"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="wizard-event-theme" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                    Event Theme / Aesthetic Direction (Optional)
                  </label>
                  <input
                    id="wizard-event-theme"
                    type="text"
                    value={eventTheme}
                    onChange={(e) => setEventTheme(e.target.value)}
                    placeholder="e.g., Candlelit Royal Amethyst & Champagne Gold, Modern Botanical Garden"
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="wizard-event-date" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Target Event Date *
                    </label>
                    <input
                      id="wizard-event-date"
                      required
                      type="date"
                      min={todayIso}
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="wizard-guests" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Estimated Guests *
                    </label>
                    <input
                      id="wizard-guests"
                      required
                      type="number"
                      min={10}
                      max={5000}
                      value={guestCount}
                      onChange={(e) => setGuestCount(Number(e.target.value))}
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="wizard-budget" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Investment Range
                    </label>
                    <select
                      id="wizard-budget"
                      value={budgetRange}
                      onChange={(e) => setBudgetRange(e.target.value)}
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      <option>$3,500 – $7,500</option>
                      <option>$7,500 – $15,000</option>
                      <option>$15,000 – $25,000</option>
                      <option>$25,000 – $45,000</option>
                      <option>$45,000+</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="wizard-location" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Event City & State *
                    </label>
                    <input
                      id="wizard-location"
                      required
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Columbia, SC"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                  <div>
                    <label htmlFor="wizard-venue" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Venue Name (if selected)
                    </label>
                    <input
                      id="wizard-venue"
                      type="text"
                      value={venueName}
                      onChange={(e) => setVenueName(e.target.value)}
                      placeholder="Lace House Gardens or Venue To Be Finalized"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-[var(--cs-charcoal)] mb-2">
                    Service Divisions of Interest
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {SERVICE_DIVISIONS.map((div) => {
                      const selected = selectedDivisions.includes(div.id);
                      return (
                        <button
                          key={div.id}
                          type="button"
                          onClick={() => toggleDivision(div.id)}
                          className={`min-h-[44px] px-3 py-2 text-left text-xs rounded-md border transition-colors cursor-pointer ${
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
              </div>
            )}

            {/* STEP 2: CONSULTATION SCHEDULING */}
            {step === 2 && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="font-display text-xl font-semibold text-[var(--cs-charcoal)]">
                      02. Choose Your Consultation Format & Time
                    </h3>
                    <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                      Live server-verified studio availability with automatic 15-minute preparation buffers.
                    </p>
                  </div>
                  <div className="min-w-[230px]">
                    <label htmlFor="wizard-tz" className="block text-[11px] font-medium text-[var(--cs-charcoal-muted)] mb-1">
                      Display Times In
                    </label>
                    <select
                      id="wizard-tz"
                      value={clientTimezone}
                      onChange={(e) => {
                        setClientTimezone(e.target.value);
                        setSelectedSlot(null);
                      }}
                      className="w-full min-h-[40px] px-3 py-1.5 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      {TIMEZONE_OPTIONS.map((tz) => (
                        <option key={tz.value} value={tz.value}>
                          {tz.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Method Selector */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {METHOD_OPTIONS.map((opt) => {
                    const active = method === opt.id;
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setMethod(opt.id);
                          setSelectedSlot(null);
                        }}
                        className={`min-h-[68px] p-3.5 rounded-lg border text-left transition-colors cursor-pointer ${
                          active
                            ? 'bg-[var(--cs-purple-soft)] border-[var(--cs-purple)] text-[var(--cs-purple)]'
                            : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal)] hover:border-[var(--cs-gold)]'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-xs font-semibold">
                          <Icon className="w-4 h-4 shrink-0" />
                          {opt.title}
                        </div>
                        <p className="text-[11px] text-[var(--cs-charcoal-muted)] mt-1">{opt.subtitle}</p>
                      </button>
                    );
                  })}
                </div>

                {availabilityError && (
                  <div role="alert" className="p-3.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded-md">
                    {availabilityError}
                  </div>
                )}

                {availabilityLoading ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="p-8 text-center text-xs text-[var(--cs-charcoal-muted)] bg-[var(--cs-ivory)] rounded-lg border border-[var(--cs-border)]"
                  >
                    Loading live Columbia studio availability...
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Horizontal 14-day Date Strip */}
                    <div>
                      <p className="text-xs font-medium text-[var(--cs-charcoal)] mb-2 inline-flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-[var(--cs-gold)]" />
                        Select Consultation Date
                      </p>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {availabilityDays.map((day) => {
                          const fmt = formatShortDayLabel(day.date);
                          const isSelected = activeDay?.date === day.date;
                          const unavailable = day.isBlackout || !day.isStudioOpen || day.availableCount === 0;
                          return (
                            <button
                              key={day.date}
                              type="button"
                              onClick={() => {
                                setSelectedDayIso(day.date);
                                setSelectedSlot(null);
                              }}
                              className={`min-w-[78px] min-h-[68px] px-2.5 py-2 rounded-lg border text-center shrink-0 transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-[var(--cs-purple)] text-white border-[var(--cs-purple)]'
                                  : unavailable
                                    ? 'bg-[var(--cs-ivory)] border-[var(--cs-border)] text-[var(--cs-charcoal-muted)]'
                                    : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal)] hover:border-[var(--cs-gold)]'
                              }`}
                            >
                              <div className="text-[10px] uppercase tracking-wider opacity-80">{fmt.weekday}</div>
                              <div className="text-xs font-semibold tabular-nums mt-0.5">
                                {fmt.month} {fmt.dayNum}
                              </div>
                              <div className="text-[10px] mt-0.5 tabular-nums opacity-85">
                                {day.isBlackout
                                  ? 'Blackout'
                                  : !day.isStudioOpen
                                    ? 'Closed'
                                    : `${day.availableCount} open`}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Time Slots Grid */}
                    {activeDay && (
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-[var(--cs-charcoal)] inline-flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-[var(--cs-gold)]" />
                            Available Windows for {activeDay.date}
                          </span>
                          <span className="text-[11px] text-[var(--cs-charcoal-muted)]">
                            Showing {clientTimezone} (Studio: ET)
                          </span>
                        </div>

                        {activeDay.isBlackout ? (
                          <div className="p-4 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
                            Studio closed on {activeDay.date}: {activeDay.blackoutReason}. Please pick another date.
                          </div>
                        ) : activeDay.slots.length === 0 ? (
                          <div className="p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md text-xs text-[var(--cs-charcoal-muted)]">
                            No consultation hours are scheduled on {activeDay.date} for {formatMethodLabel(method)}. Please choose another day.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {activeDay.slots.map((slot) => {
                              const picked = selectedSlot?.slotId === slot.slotId;
                              return (
                                <button
                                  key={slot.slotId}
                                  type="button"
                                  disabled={!slot.available}
                                  onClick={() => {
                                    setSelectedSlot(slot);
                                    idempotencyKeyRef.current = createKey('cs-consult');
                                  }}
                                  className={`min-h-[58px] px-3.5 py-2.5 rounded-lg border text-left transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                                    picked
                                      ? 'bg-[var(--cs-purple-soft)] border-[var(--cs-purple)] text-[var(--cs-purple)]'
                                      : 'bg-white border-[var(--cs-border)] text-[var(--cs-charcoal)] hover:border-[var(--cs-gold)]'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-semibold tabular-nums">{slot.displayLabel}</span>
                                    <span className="text-[10px] font-medium opacity-80">
                                      {slot.available ? `${slot.durationMinutes}m` : 'Unavailable'}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-[var(--cs-charcoal-muted)] mt-0.5 truncate">
                                    {slot.available
                                      ? `Lead: ${slot.plannerName}`
                                      : slot.unavailableReason || 'Reserved'}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* STEP 3: CLIENT DETAILS & CONSENT */}
            {step === 3 && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-xl font-semibold text-[var(--cs-charcoal)]">
                      03. Your Contact Details
                    </h3>
                    <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                      Used solely to confirm your private consultation and prepare your tailored design brief.
                    </p>
                  </div>
                  {holdExpiresAt && (
                    <span className="text-xs font-medium text-[var(--cs-purple)] inline-flex items-center gap-1.5 tabular-nums">
                      <CalendarClock className="w-3.5 h-3.5 text-[var(--cs-gold)]" />
                      Slot held for 10 minutes
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="wizard-name" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Full Name *
                    </label>
                    <input
                      id="wizard-name"
                      required
                      type="text"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      placeholder="Jordan & Camille Mercer"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                  <div>
                    <label htmlFor="wizard-email" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Email Address *
                    </label>
                    <input
                      id="wizard-email"
                      required
                      type="email"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                      placeholder="you@domain.com"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="wizard-phone" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Phone Number *
                    </label>
                    <input
                      id="wizard-phone"
                      required
                      type="tel"
                      value={clientPhone}
                      onChange={(e) => setClientPhone(e.target.value)}
                      placeholder="(803) 555-0148"
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                    />
                  </div>
                  <div>
                    <label htmlFor="wizard-pref-contact" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                      Preferred Contact Method
                    </label>
                    <select
                      id="wizard-pref-contact"
                      value={preferredContactMethod}
                      onChange={(e) => setPreferredContactMethod(e.target.value as PreferredContactMethod)}
                      className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      <option value="email">Email</option>
                      <option value="phone">Phone Call</option>
                      <option value="sms">Text / SMS</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="wizard-notes" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1.5">
                    Vision, Color Palette & Inspiration Notes
                  </label>
                  <textarea
                    id="wizard-notes"
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Share preferred florals, royal purple/champagne gold accents, cultural traditions, or corporate staging requirements..."
                    className="w-full px-3.5 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>

                <label className="flex items-start gap-3 p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacyConsent}
                    onChange={(e) => setPrivacyConsent(e.target.checked)}
                    className="mt-1 w-4 h-4 accent-[var(--cs-purple)] shrink-0"
                  />
                  <span className="text-xs text-[var(--cs-charcoal)] leading-relaxed">
                    I consent to Celebration Sisters Event Decor storing my inquiry and contact details to schedule,
                    confirm, and coordinate my private consultation and event proposal. We never sell or share client
                    information with third-party marketers.
                  </span>
                </label>
              </div>
            )}

            {/* STEP 4: REVIEW & CONFIRM */}
            {step === 4 && selectedSlot && (
              <form onSubmit={handleConfirmBooking} className="space-y-5">
                <div>
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-charcoal)]">
                    04. Review & Confirm Your Consultation
                  </h3>
                  <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                    Confirm all details below. Your consultation slot is finalized immediately upon confirmation.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg space-y-2 text-xs">
                    <div className="flex items-center justify-between border-b border-[var(--cs-border)] pb-2">
                      <span className="font-semibold text-[var(--cs-purple)]">Event Discovery</span>
                      <button
                        type="button"
                        onClick={() => setStep(1)}
                        className="text-[var(--cs-purple)] underline cursor-pointer"
                      >
                        Edit
                      </button>
                    </div>
                    <p className="font-semibold text-[var(--cs-charcoal)]">
                      {eventTitle || `${clientName} ${eventType}`}
                    </p>
                    <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                      Category: {eventType} · Target Event Date: {eventDate}
                    </p>
                    <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                      Guests: {guestCount} · Investment: {budgetRange}
                    </p>
                    {eventTheme.trim() && (
                      <p className="text-[var(--cs-charcoal-muted)]">Theme: {eventTheme.trim()}</p>
                    )}
                    <p className="text-[var(--cs-charcoal-muted)]">
                      Venue: {venueName || 'Venue To Be Finalized'} ({location})
                    </p>
                  </div>

                  <div className="p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-lg space-y-2 text-xs">
                    <div className="flex items-center justify-between border-b border-[var(--cs-border)] pb-2">
                      <span className="font-semibold text-[var(--cs-purple)]">Consultation Appointment</span>
                      <button
                        type="button"
                        onClick={() => setStep(2)}
                        className="text-[var(--cs-purple)] underline cursor-pointer"
                      >
                        Edit
                      </button>
                    </div>
                    <p className="font-semibold text-[var(--cs-purple)] tabular-nums">
                      {selectedSlot.dateLocal} · {selectedSlot.displayLabel} ({clientTimezone})
                    </p>
                    <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                      Studio Time (ET): {selectedSlot.studioDisplayLabel} · {selectedSlot.durationMinutes} min
                    </p>
                    <p className="text-[var(--cs-charcoal-muted)]">
                      Format: {formatMethodLabel(method)}
                    </p>
                    <p className="text-[var(--cs-charcoal-muted)]">
                      Assigned Lead Planner: {selectedSlot.plannerName}
                    </p>
                  </div>
                </div>

                <div className="p-4 bg-white border border-[var(--cs-border)] rounded-lg space-y-1.5 text-xs">
                  <div className="flex items-center justify-between border-b border-[var(--cs-border)] pb-2">
                    <span className="font-semibold text-[var(--cs-purple)]">Client Information</span>
                    <button
                      type="button"
                      onClick={() => setStep(3)}
                      className="text-[var(--cs-purple)] underline cursor-pointer"
                    >
                      Edit
                    </button>
                  </div>
                  <p className="text-[var(--cs-charcoal)] font-medium">
                    {clientName} · {clientEmail} · {clientPhone}
                  </p>
                  <p className="text-[var(--cs-charcoal-muted)]">
                    Preferred Contact: {preferredContactMethod.toUpperCase()} · Privacy Consent: Accepted
                  </p>
                  {notes.trim() && (
                    <p className="text-[var(--cs-charcoal-muted)] pt-1">Notes: {notes.trim()}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--cs-border)]">
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="min-h-[44px] px-4 py-2 text-xs font-medium text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-charcoal)] inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Details
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="min-h-[44px] px-7 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {submitting ? 'Confirming Consultation...' : 'Confirm Private Consultation'}
                  </button>
                </div>
              </form>
            )}

            {/* Wizard Navigation Footer for Steps 1–3 */}
            {step < 4 && (
              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--cs-border)]">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    if (step === 1) onClose();
                    else setStep((step - 1) as 1 | 2 | 3);
                  }}
                  className="min-h-[44px] px-4 py-2 text-xs font-medium text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-charcoal)] inline-flex items-center gap-1.5 cursor-pointer"
                >
                  {step > 1 && <ArrowLeft className="w-4 h-4" />}
                  {step === 1 ? 'Cancel' : 'Previous Step'}
                </button>
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="min-h-[44px] px-6 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md inline-flex items-center gap-2 cursor-pointer"
                >
                  {step === 3 ? 'Review Consultation' : 'Continue'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
