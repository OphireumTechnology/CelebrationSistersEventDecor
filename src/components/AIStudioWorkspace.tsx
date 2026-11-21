import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  History,
  Info,
  Layers,
  Loader2,
  Palette,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Wand2,
} from 'lucide-react';
import { AI_RESPONSE_TIMEOUT_MS } from '../lib/aiTimeouts.mjs';
import { apiFetch, isBackendConfigured, parseApiErrorResponse } from '../lib/apiClient';
import type { ConceptRevision, DesignConceptRecord, UserSession } from '../types/domain';

interface AIStudioWorkspaceProps {
  currentUser: UserSession;
  onOpenBookingPrefilled: (prefill: {
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }) => void;
}

interface ConciergeMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface ExtractedLead {
  eventCategory: string;
  eventDate: string;
  location: string;
  guestCount: number | null;
  theme: string;
  budgetRange: string;
  recommendedDivisions: string[];
  needsHumanEscalation: boolean;
  summary: string;
}

type StudioStatus =
  | 'idle'
  | 'generating'
  | 'saving'
  | 'success'
  | 'retryable_error'
  | 'validation_error'
  | 'persistence_error'
  | 'session_error';

interface StudioFeedback {
  status: StudioStatus;
  message: string;
  code?: string;
  retryable?: boolean;
  requestId?: string;
}

function generateIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rand}`;
}

function isValidConceptPayload(candidate: unknown): candidate is DesignConceptRecord {
  if (!candidate || typeof candidate !== 'object') return false;
  const c = candidate as Partial<DesignConceptRecord>;
  if (typeof c.id !== 'string' || c.id.trim().length === 0) return false;
  if (!Array.isArray(c.revisions) || c.revisions.length === 0) return false;
  const first = c.revisions[0] as Partial<ConceptRevision> | undefined;
  if (!first || typeof first.themeName !== 'string' || first.themeName.trim().length === 0) return false;
  if (typeof first.visionSummary !== 'string' || first.visionSummary.trim().length === 0) return false;
  if (!Array.isArray(first.colorPalette) || first.colorPalette.length === 0) return false;
  return true;
}

function formatRevisionTimestamp(iso?: string): string {
  if (!iso) return 'Just generated';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function AIStudioWorkspace(props: AIStudioWorkspaceProps) {
  return (
    <IdentityScopedAIStudioWorkspace
      key={JSON.stringify([props.currentUser.id, props.currentUser.role])}
      {...props}
    />
  );
}

function IdentityScopedAIStudioWorkspace({
  currentUser,
  onOpenBookingPrefilled,
}: AIStudioWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<'concierge' | 'concept'>('concierge');

  // AI Event Concierge State
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ConciergeMsg[]>([
    {
      role: 'assistant',
      content:
        'Welcome to Celebration Sisters Event Decor. I am your Columbia luxury event concierge. Tell me about the celebration you are envisioning — event type, approximate date, venue or city, and guest count — and I will curate tailored service divisions and prepare your planner brief.',
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [lastFailedConciergeMessage, setLastFailedConciergeMessage] = useState<string | null>(null);
  const [conciergeLoading, setConciergeLoading] = useState(false);
  const [conciergeFeedback, setConciergeFeedback] = useState<StudioFeedback | null>(null);
  const [extractedLead, setExtractedLead] = useState<ExtractedLead | null>(null);

  // AI Concept Studio State
  const [concepts, setConcepts] = useState<DesignConceptRecord[]>([]);
  const [selectedConceptId, setSelectedConceptId] = useState<string>('');
  const [activeRevisionIndex, setActiveRevisionIndex] = useState<number>(0);
  const [conceptLoading, setConceptLoading] = useState(false);
  const [conceptFeedback, setConceptFeedback] = useState<StudioFeedback>({
    status: 'idle',
    message: '',
  });
  const [lastFailedReviseFlag, setLastFailedReviseFlag] = useState<boolean>(false);
  const [pendingIdempotencyKey, setPendingIdempotencyKey] =
    useState<{
      key: string;
      fingerprint: string;
    } | null>(null);
  const [approvalSaving, setApprovalSaving] = useState(false);

  const [conceptForm, setConceptForm] = useState({
    eventType: 'Wedding Planning and Design',
    guestCount: 150,
    venueStyle: 'Historic Southern Estate & Ballroom',
    preferredPalette: 'Royal Purple, Champagne Gold, and Soft Ivory',
    visionDescription:
      'Candlelit estate reception with elevated ivory floral towers, velvet lounge seating, and warm gold table details.',
  });

  const moodBoardRef = useRef<HTMLDivElement | null>(null);
  const conceptSubmitInFlightRef = useRef(false);
  const conciergeSubmitInFlightRef = useRef(false);
  const conceptRequestSeqRef = useRef(0);
  const conciergeRequestSeqRef = useRef(0);

  // Load persisted concepts ONLY when authenticated user identity changes (never on selectedConceptId change!)
  useEffect(() => {
    let active = true;

    const loadConcepts = async () => {
      if (!isBackendConfigured) {
        if (active) {
          setConcepts([]);
          setSelectedConceptId('');
        }
        return;
      }

      if (currentUser.role === 'guest') {
        // Clear any previous authenticated user's private concepts when switching to guest,
        // without interfering with concepts generated during the active guest session.
        if (active) {
          setConcepts((prev) => prev.filter((c) => c.clientId === 'public-concierge-preview'));
          setSelectedConceptId((prevId) => prevId);
        }
        return;
      }

      try {
        const res = await apiFetch('/api/concepts', {
          credentials: 'include',
          timeoutMs: 15_000,
        });
        if (!active) return;

        if (res.status === 401 || res.status === 403) {
          setPendingIdempotencyKey(null);
          setActiveRevisionIndex(0);
          setConceptFeedback({
            status: 'session_error',
            code: res.status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN',
            message: 'Your saved concepts require an authorized sign-in session. Please sign in again to access saved boards.',
            retryable: false,
          });
          setConcepts([]);
          setSelectedConceptId('');
          return;
        }

        if (res.ok) {
          const data = (await res.json()) as { concepts?: DesignConceptRecord[] };
          if (!active) return;
          const list = Array.isArray(data.concepts) ? data.concepts : [];
          setConcepts(list);
          setSelectedConceptId((prevSelected) => {
            if (prevSelected && list.some((c) => c.id === prevSelected)) {
              return prevSelected;
            }
            return list[0]?.id || '';
          });
          setActiveRevisionIndex(0);
        }
      } catch {
        // Preserve current client state on transient load issue
      }
    };

    void loadConcepts();
    return () => {
      active = false;
    };
  }, [currentUser.id, currentUser.role]);

  const selectedConcept = concepts.find((c) => c.id === selectedConceptId) || concepts[0] || null;
  const activeRevision: ConceptRevision | null = selectedConcept
    ? selectedConcept.revisions[activeRevisionIndex] || selectedConcept.revisions[0] || null
    : null;

  const updateConceptForm = (patch: Partial<typeof conceptForm>) => {
    setConceptForm((prev) => ({ ...prev, ...patch }));
    // Fresh inputs require a fresh idempotency key so edits are never deduplicated against an older vision
    setPendingIdempotencyKey(null);
  };

  const sendConciergeMessage = async (messageOverride?: string) => {
    const trimmed = (messageOverride ?? inputText).trim();
    if (!trimmed || conciergeLoading || conciergeSubmitInFlightRef.current) return;

    conciergeSubmitInFlightRef.current = true;
    const requestSeq = ++conciergeRequestSeqRef.current;
    const isRetry = messageOverride !== undefined;
    const priorHistory = messages;
    const optimisticMessages: ConciergeMsg[] = isRetry
      ? messages
      : [...messages, { role: 'user', content: trimmed }];

    setMessages(optimisticMessages);
    if (!isRetry) {
      setInputText('');
    }
    setConciergeLoading(true);
    setConciergeFeedback(null);
    setLastFailedConciergeMessage(null);

    try {
      const res = await apiFetch('/api/ai/concierge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        timeoutMs: AI_RESPONSE_TIMEOUT_MS,
        body: JSON.stringify({
          sessionId,
          clientName: currentUser.role !== 'guest' ? currentUser.name : undefined,
          message: trimmed,
          history: priorHistory,
        }),
      });

      if (requestSeq !== conciergeRequestSeqRef.current) return;

      if (!res.ok) {
        const parsedErr = await parseApiErrorResponse(
          res,
          'AI Event Concierge could not respond right now. Please try again.',
        );
        // Preserve user's draft input so they never lose their message
        if (!isRetry) {
          setMessages(priorHistory);
          setInputText(trimmed);
        }
        setLastFailedConciergeMessage(trimmed);
        setConciergeFeedback({
          status:
            parsedErr.status === 400
              ? 'validation_error'
              : parsedErr.status === 401
                ? 'session_error'
                : parsedErr.code === 'AI_PERSISTENCE_FAILED'
                  ? 'persistence_error'
                  : 'retryable_error',
          message: parsedErr.message,
          code: parsedErr.code,
          retryable: parsedErr.retryable || parsedErr.status >= 500 || parsedErr.status === 429,
          requestId: parsedErr.requestId,
        });
        return;
      }

      const data = (await res.json()) as {
        sessionId?: string;
        reply?: string;
        extractedLead?: ExtractedLead;
        requestId?: string;
      };

      if (!data.reply || typeof data.reply !== 'string') {
        if (!isRetry) {
          setMessages(priorHistory);
          setInputText(trimmed);
        }
        setLastFailedConciergeMessage(trimmed);
        setConciergeFeedback({
          status: 'retryable_error',
          code: 'INVALID_RESPONSE_PAYLOAD',
          message: 'The AI Event Concierge returned an incomplete response. Please retry.',
          retryable: true,
          requestId: data.requestId,
        });
        return;
      }

      if (data.sessionId) setSessionId(data.sessionId);
      setMessages((prev) => {
        const base = isRetry ? [...priorHistory, { role: 'user' as const, content: trimmed }] : prev;
        return [...base, { role: 'assistant' as const, content: data.reply! }];
      });
      if (data.extractedLead) setExtractedLead(data.extractedLead);
      setConciergeFeedback({
        status: 'success',
        message: 'Concierge brief updated.',
        requestId: data.requestId,
      });
    } catch {
      if (!isRetry) {
        setMessages(priorHistory);
        setInputText(trimmed);
      }
      setLastFailedConciergeMessage(trimmed);
      setConciergeFeedback({
        status: 'retryable_error',
        code: 'NETWORK_ERROR',
        message:
          'Unable to reach the AI Event Concierge right now. Your message is preserved below — please click Retry.',
        retryable: true,
      });
    } finally {
      setConciergeLoading(false);
      conciergeSubmitInFlightRef.current = false;
    }
  };

  const handleGenerateConcept = async (reviseExisting: boolean, isRetry = false) => {
    if (conceptLoading || conceptSubmitInFlightRef.current) return;

    if (
      reviseExisting &&
      (!selectedConcept || currentUser.role === 'guest')
    ) {
      setPendingIdempotencyKey(null);
      setConceptFeedback({
        status: 'validation_error',
        code: 'CONCEPT_REQUIRED',
        message: 'Select an authorized concept before creating a revision.',
        retryable: false,
      });
      return;
    }

    // Client-side pre-validation so invalid entries produce crisp, immediate feedback without losing inputs
    const trimmedVenue = conceptForm.venueStyle.trim();
    const trimmedPalette = conceptForm.preferredPalette.trim();
    const trimmedVision = conceptForm.visionDescription.trim();
    const guestCountNum = Number(conceptForm.guestCount);

    if (
      !Number.isInteger(guestCountNum) ||
      guestCountNum < 10 ||
      guestCountNum > 2000 ||
      trimmedVenue.length < 2 ||
      trimmedPalette.length < 2 ||
      trimmedVision.length < 5
    ) {
      setConceptFeedback({
        status: 'validation_error',
        code: 'VALIDATION_ERROR',
        message:
          'Please provide a guest count between 10 and 2,000, a venue style, a color palette, and at least 5 characters describing your vision.',
        retryable: false,
      });
      return;
    }

    conceptSubmitInFlightRef.current = true;
    setConceptLoading(true);
    setLastFailedReviseFlag(reviseExisting);
    setConceptFeedback({
      status: 'generating',
      message: reviseExisting
        ? 'Composing your updated concept revision and saving to your board...'
        : 'Composing your custom luxury concept mood board...',
    });

    const requestBody = JSON.stringify({
      conceptId: reviseExisting && selectedConcept
        ? selectedConcept.id
        : undefined,
      eventType: conceptForm.eventType,
      guestCount: guestCountNum,
      venueStyle: trimmedVenue,
      preferredPalette: trimmedPalette,
      visionDescription: trimmedVision,
    });

    const fingerprint = JSON.stringify([
      currentUser.id,
      currentUser.role,
      reviseExisting,
      requestBody,
    ]);

    const requestSeq = ++conceptRequestSeqRef.current;

    const idempotencyKey =
      isRetry &&
      pendingIdempotencyKey?.fingerprint === fingerprint
        ? pendingIdempotencyKey.key
        : generateIdempotencyKey(reviseExisting ? 'cnc-rev' : 'cnc-new');

    setPendingIdempotencyKey({
      key: idempotencyKey,
      fingerprint,
    });

    try {
      const res = await apiFetch('/api/ai/concept-studio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        credentials: 'include',
        timeoutMs: AI_RESPONSE_TIMEOUT_MS,
        body: requestBody,
      });

      if (requestSeq !== conceptRequestSeqRef.current) return;

      if (!res.ok) {
        const parsedErr = await parseApiErrorResponse(
          res,
          'Unable to generate concept proposal right now. Your inputs are preserved — please try again.',
        );
        if (requestSeq !== conceptRequestSeqRef.current) return;
        if (parsedErr.status === 401 || parsedErr.status === 403) {
          setConcepts([]);
          setSelectedConceptId('');
          setActiveRevisionIndex(0);
          setPendingIdempotencyKey(null);
          setConceptFeedback({
            status: 'session_error',
            code: parsedErr.code,
            message: parsedErr.message,
            retryable: false,
            requestId: parsedErr.requestId,
          });
          return;
        }
        if (parsedErr.code === 'IDEMPOTENCY_CONFLICT') {
          setPendingIdempotencyKey(null);
          setConceptFeedback({
            status: 'validation_error',
            code: parsedErr.code,
            message:
              'The previous request key is no longer valid. Your inputs are preserved. Generate a new proposal or revision to continue.',
            retryable: false,
            requestId: parsedErr.requestId,
          });
          return;
        }
        // On provider/request timeout, the backend intentionally retains the timed-out
        // idempotency lease to block automatic duplicate replays across replicas.
        // Clearing pendingIdempotencyKey allows an explicit manual Retry click to issue
        // a fresh Idempotency-Key instead of looping on 503 AI_SERVICE_BUSY.
        if (parsedErr.code === 'AI_TIMEOUT' || parsedErr.code === 'REQUEST_TIMEOUT') {
          setPendingIdempotencyKey(null);
        }

        const status: StudioStatus =
          parsedErr.status === 400
            ? 'validation_error'
            : parsedErr.status === 401
              ? 'session_error'
              : parsedErr.code === 'AI_PERSISTENCE_FAILED'
                ? 'persistence_error'
                : 'retryable_error';
        setConceptFeedback({
          status,
          code: parsedErr.code,
          message: parsedErr.message,
          retryable: parsedErr.retryable || parsedErr.status >= 500 || parsedErr.status === 429,
          requestId: parsedErr.requestId,
        });
        return;
      }

      setConceptFeedback({
        status: 'saving',
        message: 'Validating and displaying your saved mood board...',
      });

      const data = (await res.json().catch(() => ({}))) as {
        concept?: unknown;
        persisted?: boolean;
        deduplicated?: boolean;
        requestId?: string;
      };

      if (!isValidConceptPayload(data.concept)) {
        setConceptFeedback({
          status: 'persistence_error',
          code: 'INVALID_CONCEPT_PAYLOAD',
          message:
            'The server responded without a valid mood board payload. Your celebration details are preserved — please click Retry.',
          retryable: true,
          requestId: data.requestId || res.headers.get('X-Request-Id') || undefined,
        });
        return;
      }

      const created = data.concept;
      const latestIdx = created.revisions.findIndex((r) => r.version === created.currentVersion);
      const targetRevIndex = latestIdx >= 0 ? latestIdx : 0;

      setConcepts((prev) => {
        const exists = prev.some((c) => c.id === created.id);
        return exists ? prev.map((c) => (c.id === created.id ? created : c)) : [created, ...prev];
      });
      setSelectedConceptId(created.id);
      setActiveRevisionIndex(targetRevIndex);
      setPendingIdempotencyKey(null);

      setConceptFeedback({
        status: 'success',
        message: reviseExisting
          ? `Revision v${created.currentVersion} saved and displayed (${created.id}).`
          : `Concept proposal "${created.revisions[targetRevIndex]?.themeName}" saved and ready (${created.id}).`,
        requestId: data.requestId || res.headers.get('X-Request-Id') || undefined,
      });

      // Bring the newly rendered mood board into clear viewport focus (critical on mobile & smaller screens)
      requestAnimationFrame(() => {
        moodBoardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        moodBoardRef.current?.focus?.({ preventScroll: true });
      });
    } catch {
      setConceptFeedback({
        status: 'retryable_error',
        code: 'NETWORK_ERROR',
        message:
          'Unable to reach the Concept Studio AI service. Your celebration details are preserved — please click Retry.',
        retryable: true,
      });
    } finally {
      setConceptLoading(false);
      conceptSubmitInFlightRef.current = false;
    }
  };

  const handleApproveConcept = async () => {
    if (!selectedConcept || currentUser.role === 'guest' || approvalSaving) return;
    setApprovalSaving(true);
    try {
      const res = await apiFetch(`/api/concepts/${selectedConcept.id}/approve`, {
        method: 'POST',
        credentials: 'include',
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        const parsedErr = await parseApiErrorResponse(res, 'Could not record concept approval.');
        setConceptFeedback({
          status: parsedErr.status === 401 ? 'session_error' : 'persistence_error',
          code: parsedErr.code,
          message: parsedErr.message,
          retryable: parsedErr.retryable,
          requestId: parsedErr.requestId,
        });
        return;
      }
      const data = (await res.json()) as { concept: DesignConceptRecord };
      setConcepts((prev) => prev.map((c) => (c.id === data.concept.id ? data.concept : c)));
      setConceptFeedback({
        status: 'success',
        message:
          currentUser.role === 'client'
            ? 'Client design approval recorded on this concept board.'
            : 'Lead designer sign-off recorded on this concept board.',
      });
    } catch {
      setConceptFeedback({
        status: 'retryable_error',
        code: 'NETWORK_ERROR',
        message: 'Unable to reach the approval server right now. Please try again.',
        retryable: true,
      });
    } finally {
      setApprovalSaving(false);
    }
  };

  const canReviseSelected =
    Boolean(selectedConcept) &&
    currentUser.role !== 'guest' &&
    !(selectedConcept?.clientApproved && selectedConcept?.staffApproved && currentUser.role === 'client');

  return (
    <div className="bg-white min-h-[82vh]">
      {/* Header Banner */}
      <section className="bg-[var(--cs-cream)] border-b border-[var(--cs-border)] py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--cs-gold)]">
              Celebration Sisters Intelligent Design Suite
            </p>
            <h1 className="font-serif text-4xl sm:text-5xl text-[var(--cs-purple)] mt-2">
              AI Concierge & Event Concept Studio
            </h1>
            <p className="text-sm text-[var(--cs-charcoal-light)] mt-3 max-w-2xl leading-relaxed">
              Explore service divisions with our luxury concierge or compose structured conceptual
              mood boards with color palettes, floral installations, and lighting plans. All AI
              proposals remain conceptual visualizations subject to human Lead Planner review.
            </p>
          </div>

          <div className="inline-flex bg-white p-1.5 rounded-xl border border-[var(--cs-border)] shadow-sm self-start lg:self-auto">
            <button
              type="button"
              onClick={() => setActiveTab('concierge')}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${
                activeTab === 'concierge'
                  ? 'bg-[var(--cs-purple)] text-white shadow-sm'
                  : 'text-[var(--cs-charcoal)] hover:bg-[var(--cs-cream)]'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              AI Event Concierge
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('concept')}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${
                activeTab === 'concept'
                  ? 'bg-[var(--cs-purple)] text-white shadow-sm'
                  : 'text-[var(--cs-charcoal)] hover:bg-[var(--cs-cream)]'
              }`}
            >
              <Palette className="w-4 h-4" />
              AI Concept Studio
            </button>
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {!isBackendConfigured && (
          <div className="mb-8 rounded-2xl border border-[var(--cs-gold)]/40 bg-[var(--cs-cream)] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-[var(--cs-purple)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-[var(--cs-purple)]">
                  Live AI Studio requires the Celebration Sisters backend API connection
                </p>
                <p className="text-xs text-[var(--cs-charcoal-light)] mt-1 leading-relaxed">
                  You are viewing the static GitHub Pages preview build. Live Gemini AI Concierge
                  sessions and saved Concept Studio mood boards activate automatically once{' '}
                  <code className="text-[11px] bg-white px-1.5 py-0.5 rounded border border-[var(--cs-border)]">
                    VITE_API_BASE_URL
                  </code>{' '}
                  is connected to the deployed Express API service.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenBookingPrefilled({ location: 'Columbia, SC' })}
              className="px-4 py-2.5 rounded-lg bg-[var(--cs-purple)] text-white text-xs font-semibold shrink-0 hover:bg-[var(--cs-purple-dark)]"
            >
              Request Direct Consultation
            </button>
          </div>
        )}

        {/* TAB 1: AI EVENT CONCIERGE */}
        {activeTab === 'concierge' && (
          <div className="grid lg:grid-cols-12 gap-8 items-start">
            {/* Chat Column */}
            <div className="lg:col-span-8 bg-white rounded-2xl border border-[var(--cs-border)] shadow-sm overflow-hidden flex flex-col h-[620px]">
              <div className="px-6 py-4 bg-[var(--cs-purple)] text-white flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-[var(--cs-gold-light)]" />
                  </div>
                  <div>
                    <p className="font-serif text-lg leading-tight">
                      Celebration Sisters AI Concierge
                    </p>
                    <p className="text-[11px] text-white/75">
                      Columbia & Midlands SC • Powered by Server-Side Gemini • Human Escalation Ready
                    </p>
                  </div>
                </div>
                {sessionId && (
                  <span className="text-[11px] font-mono bg-white/10 px-2.5 py-1 rounded-md">
                    {sessionId}
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-[var(--cs-cream)]/40">
                {messages.map((m, idx) => (
                  <div
                    key={idx}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[82%] rounded-2xl px-5 py-3.5 text-sm leading-relaxed shadow-sm ${
                        m.role === 'user'
                          ? 'bg-[var(--cs-purple)] text-white rounded-br-sm'
                          : 'bg-white border border-[var(--cs-border)] text-[var(--cs-charcoal)] rounded-bl-sm'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {conciergeLoading && (
                  <div className="flex justify-start" role="status" aria-live="polite">
                    <div className="bg-white border border-[var(--cs-border)] rounded-2xl px-5 py-3.5 text-sm text-[var(--cs-charcoal-light)] flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--cs-gold)]" />
                      Curating tailored Columbia event guidance...
                    </div>
                  </div>
                )}
                {conciergeFeedback && conciergeFeedback.status !== 'success' && (
                  <div
                    role="alert"
                    className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-800 space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" />
                      <div className="flex-1">
                        <p className="font-semibold text-red-900">{conciergeFeedback.message}</p>
                        {conciergeFeedback.requestId && (
                          <p className="text-[11px] text-red-700/80 font-mono mt-1">
                            Ref: {conciergeFeedback.requestId}
                            {conciergeFeedback.code ? ` • ${conciergeFeedback.code}` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                    {conciergeFeedback.retryable && lastFailedConciergeMessage && (
                      <div className="flex items-center gap-2 pl-6">
                        <button
                          type="button"
                          onClick={() => void sendConciergeMessage(lastFailedConciergeMessage)}
                          disabled={conciergeLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-700 text-white text-xs font-semibold hover:bg-red-800 disabled:opacity-50"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Retry Concierge Request
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Suggested Prompts */}
              <div className="px-6 py-2.5 bg-white border-t border-[var(--cs-border)] flex flex-wrap gap-2">
                {[
                  'Autumn estate wedding in Columbia for 180 guests in purple & gold',
                  'Corporate awards gala for 300 guests with lighting & DJ',
                  'Garden baby shower in Irmo for 50 guests with balloon garland',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInputText(prompt)}
                    className="text-[11px] px-3 py-1.5 rounded-md bg-[var(--cs-cream)] text-[var(--cs-purple)] hover:bg-[var(--cs-purple)]/10 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendConciergeMessage();
                }}
                className="p-4 bg-white border-t border-[var(--cs-border)] flex gap-3"
              >
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Describe your event type, target date, venue, and guest count..."
                  aria-label="Message for AI Event Concierge"
                  className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--cs-border)] text-sm focus:outline-none focus:border-[var(--cs-purple)]"
                />
                <button
                  type="submit"
                  disabled={conciergeLoading || !inputText.trim()}
                  className="px-5 py-2.5 rounded-xl bg-[var(--cs-purple)] text-white text-sm font-medium hover:bg-[var(--cs-purple-dark)] disabled:opacity-50 flex items-center gap-2 transition-colors"
                >
                  <Send className="w-4 h-4" />
                  Send
                </button>
              </form>
            </div>

            {/* Structured Lead & Escalation Panel */}
            <div className="lg:col-span-4 space-y-5">
              <div className="bg-[var(--cs-cream)] rounded-2xl border border-[var(--cs-border)] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--cs-gold)]">
                  Captured Planner Brief
                </p>
                <h2 className="font-serif text-2xl text-[var(--cs-purple)] mt-1">
                  Structured Event Summary
                </h2>
                <p className="text-xs text-[var(--cs-charcoal-light)] mt-1">
                  Automatically extracted from your conversation so our Columbia planning team can
                  prepare your consultation seamlessly.
                </p>

                {extractedLead ? (
                  <div className="mt-5 space-y-3 text-sm">
                    <div className="p-3 bg-white rounded-xl border border-[var(--cs-border)]">
                      <p className="text-[11px] uppercase tracking-wider text-[var(--cs-charcoal-light)]">
                        Event Category
                      </p>
                      <p className="font-medium text-[var(--cs-purple)] mt-0.5">
                        {extractedLead.eventCategory}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 bg-white rounded-xl border border-[var(--cs-border)]">
                        <p className="text-[11px] uppercase tracking-wider text-[var(--cs-charcoal-light)]">
                          Target Date
                        </p>
                        <p className="font-medium text-[var(--cs-charcoal)] mt-0.5">
                          {extractedLead.eventDate || 'TBD'}
                        </p>
                      </div>
                      <div className="p-3 bg-white rounded-xl border border-[var(--cs-border)]">
                        <p className="text-[11px] uppercase tracking-wider text-[var(--cs-charcoal-light)]">
                          Guests
                        </p>
                        <p className="font-medium text-[var(--cs-charcoal)] mt-0.5">
                          {extractedLead.guestCount ?? 'TBD'}
                        </p>
                      </div>
                    </div>
                    <div className="p-3 bg-white rounded-xl border border-[var(--cs-border)]">
                      <p className="text-[11px] uppercase tracking-wider text-[var(--cs-charcoal-light)]">
                        Location & Aesthetic
                      </p>
                      <p className="font-medium text-[var(--cs-charcoal)] mt-0.5">
                        {extractedLead.location || 'Columbia, SC'} •{' '}
                        {extractedLead.theme || 'Bespoke Luxury'}
                      </p>
                    </div>
                    {extractedLead.recommendedDivisions?.length > 0 && (
                      <div className="p-3 bg-white rounded-xl border border-[var(--cs-border)]">
                        <p className="text-[11px] uppercase tracking-wider text-[var(--cs-charcoal-light)] mb-1.5">
                          Recommended Divisions
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {extractedLead.recommendedDivisions.map((d) => (
                            <span
                              key={d}
                              className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--cs-cream)] text-[var(--cs-purple)] font-medium"
                            >
                              {d}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {extractedLead.needsHumanEscalation && (
                      <div className="p-3.5 rounded-xl bg-[var(--cs-purple)]/5 border border-[var(--cs-purple)]/25 text-xs text-[var(--cs-purple)] flex items-start gap-2.5">
                        <UserCheck className="w-4 h-4 shrink-0 mt-0.5 text-[var(--cs-gold)]" />
                        <span>
                          <strong>Human Planner Recommended:</strong> This request involves custom
                          quotations, availability confirmation, or contract coordination.
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        onOpenBookingPrefilled({
                          eventType: extractedLead.eventCategory,
                          location: extractedLead.location || 'Columbia, SC',
                          guestCount: extractedLead.guestCount || 120,
                          notes: extractedLead.summary,
                        })
                      }
                      className="w-full py-3 px-4 rounded-xl bg-[var(--cs-purple)] text-white text-sm font-medium hover:bg-[var(--cs-purple-dark)] flex items-center justify-center gap-2 transition-colors"
                    >
                      Transfer Brief to Consultation Form
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="mt-5 p-4 rounded-xl bg-white border border-dashed border-[var(--cs-border)] text-xs text-[var(--cs-charcoal-light)] leading-relaxed">
                    Start chatting with the concierge to see your event category, estimated guest
                    count, aesthetic direction, and recommended Celebration Sisters divisions
                    populated here in real time.
                  </div>
                )}
              </div>

              <div className="bg-white rounded-2xl border border-[var(--cs-border)] p-5 text-xs text-[var(--cs-charcoal-light)] space-y-2">
                <p className="font-semibold text-[var(--cs-purple)] flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[var(--cs-gold)]" />
                  Responsible AI Guardrails
                </p>
                <p>
                  Our concierge never issues binding contracts, unauthorized discounts, or
                  unverified venue holds. Final itemized quotations are always reviewed and issued
                  by our Lead Planning Team.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: AI CONCEPT STUDIO */}
        {activeTab === 'concept' && (
          <div className="grid lg:grid-cols-12 gap-8 items-start">
            {/* Generator Form */}
            <div className="lg:col-span-5 bg-[var(--cs-cream)] rounded-2xl border border-[var(--cs-border)] p-6 space-y-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--cs-gold)]">
                  Concept Studio Composer
                </p>
                <h2 className="font-serif text-2xl text-[var(--cs-purple)] mt-1">
                  Generate Event Mood Board
                </h2>
              </div>

              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="concept-event-type"
                    className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1"
                  >
                    Event Type
                  </label>
                  <select
                    id="concept-event-type"
                    value={conceptForm.eventType}
                    onChange={(e) => updateConceptForm({ eventType: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-[var(--cs-border)] text-sm"
                  >
                    <option>Wedding Planning and Design</option>
                    <option>Corporate Events</option>
                    <option>Birthday Celebrations</option>
                    <option>Baby Showers and Gender Reveals</option>
                    <option>Anniversaries and Private Events</option>
                    <option>Custom Event Concepts and Full Production</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="concept-guest-count"
                      className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1"
                    >
                      Guest Count
                    </label>
                    <input
                      id="concept-guest-count"
                      type="number"
                      min={10}
                      max={2000}
                      value={conceptForm.guestCount}
                      onChange={(e) =>
                        updateConceptForm({ guestCount: Number(e.target.value) || 0 })
                      }
                      className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-[var(--cs-border)] text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="concept-venue-style"
                      className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1"
                    >
                      Venue Style
                    </label>
                    <input
                      id="concept-venue-style"
                      type="text"
                      value={conceptForm.venueStyle}
                      onChange={(e) => updateConceptForm({ venueStyle: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-[var(--cs-border)] text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="concept-preferred-palette"
                    className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1"
                  >
                    Preferred Palette
                  </label>
                  <input
                    id="concept-preferred-palette"
                    type="text"
                    value={conceptForm.preferredPalette}
                    onChange={(e) => updateConceptForm({ preferredPalette: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-[var(--cs-border)] text-sm"
                  />
                </div>

                <div>
                  <label
                    htmlFor="concept-vision-description"
                    className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1"
                  >
                    Celebration Vision & Signature Elements
                  </label>
                  <textarea
                    id="concept-vision-description"
                    rows={4}
                    value={conceptForm.visionDescription}
                    onChange={(e) => updateConceptForm({ visionDescription: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-[var(--cs-border)] text-sm"
                  />
                </div>

                {/* Explicit Status Feedback Banners */}
                {(conceptFeedback.status === 'generating' || conceptFeedback.status === 'saving') && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="p-3.5 rounded-xl bg-[var(--cs-purple)]/5 border border-[var(--cs-purple)]/20 text-xs text-[var(--cs-purple)] flex items-center gap-2.5"
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--cs-gold)] shrink-0" />
                    <span>{conceptFeedback.message}</span>
                  </div>
                )}

                {conceptFeedback.status === 'success' && conceptFeedback.message && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-start gap-2.5"
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">{conceptFeedback.message}</p>
                      {conceptFeedback.requestId && (
                        <p className="text-[11px] text-emerald-800/75 font-mono mt-0.5">
                          Ref: {conceptFeedback.requestId}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {(conceptFeedback.status === 'retryable_error' ||
                  conceptFeedback.status === 'validation_error' ||
                  conceptFeedback.status === 'persistence_error' ||
                  conceptFeedback.status === 'session_error') && (
                  <div
                    role="alert"
                    className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" />
                      <div className="flex-1">
                        <p className="font-semibold text-red-900">{conceptFeedback.message}</p>
                        {conceptFeedback.requestId && (
                          <p className="text-[11px] text-red-700/80 font-mono mt-1">
                            Ref: {conceptFeedback.requestId}
                            {conceptFeedback.code ? ` • ${conceptFeedback.code}` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                    {conceptFeedback.retryable && (
                      <div className="pl-6">
                        <button
                          type="button"
                          onClick={() => void handleGenerateConcept(lastFailedReviseFlag, true)}
                          disabled={conceptLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-700 text-white text-xs font-semibold hover:bg-red-800 disabled:opacity-50"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Retry Proposal Generation
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-3 pt-1">
                  <button
                    type="button"
                    disabled={conceptLoading}
                    onClick={() => void handleGenerateConcept(false)}
                    className="flex-1 py-3 px-4 rounded-xl bg-[var(--cs-purple)] text-white text-sm font-medium hover:bg-[var(--cs-purple-dark)] disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
                  >
                    {conceptLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Wand2 className="w-4 h-4" />
                    )}
                    {conceptLoading ? 'Composing Proposal...' : 'Create New Concept Proposal'}
                  </button>
                  {canReviseSelected && (
                    <button
                      type="button"
                      disabled={conceptLoading}
                      onClick={() => void handleGenerateConcept(true)}
                      className="py-3 px-4 rounded-xl bg-white border border-[var(--cs-purple)] text-[var(--cs-purple)] text-sm font-medium hover:bg-[var(--cs-purple)]/5 disabled:opacity-50 transition-colors"
                    >
                      Save as Revision v{(selectedConcept?.currentVersion ?? 1) + 1}
                    </button>
                  )}
                </div>
              </div>

              {/* Saved Concepts Selector */}
              {concepts.length > 0 && (
                <div className="pt-4 border-t border-[var(--cs-border)]">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-charcoal-light)] mb-2.5">
                    {currentUser.role === 'guest'
                      ? 'Generated Session Proposals'
                      : `Saved Concept Boards (${concepts.length})`}
                  </p>
                  <div className="space-y-2">
                    {concepts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedConceptId(c.id);
                          const latestIdx = c.revisions.findIndex(
                            (r) => r.version === c.currentVersion,
                          );
                          setActiveRevisionIndex(latestIdx >= 0 ? latestIdx : 0);
                        }}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl border text-xs transition-colors flex items-center justify-between ${
                          selectedConcept?.id === c.id
                            ? 'bg-white border-[var(--cs-purple)] shadow-sm'
                            : 'bg-white/60 border-[var(--cs-border)] hover:bg-white'
                        }`}
                      >
                        <div>
                          <p className="font-semibold text-[var(--cs-purple)]">{c.title}</p>
                          <p className="text-[var(--cs-charcoal-light)] mt-0.5">
                            {c.eventType} • v{c.currentVersion} •{' '}
                            <span className="font-mono text-[10px]">{c.id}</span>
                          </p>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-md font-medium ${
                            c.clientApproved && c.staffApproved
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {c.clientApproved && c.staffApproved ? 'Dual Approved' : 'In Review'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Concept Board Output Display */}
            <div
              ref={moodBoardRef}
              tabIndex={-1}
              data-testid="concept-mood-board"
              className="lg:col-span-7 outline-none scroll-mt-24"
            >
              {selectedConcept && activeRevision ? (
                <div className="bg-white rounded-2xl border border-[var(--cs-border)] shadow-sm overflow-hidden">
                  {/* Conceptual Label & Revision Selector */}
                  <div className="px-6 py-4 bg-[var(--cs-purple)] text-white flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] px-2.5 py-0.5 rounded-md bg-[var(--cs-gold)] text-white">
                          Conceptual Visualization
                        </span>
                        <span className="text-xs text-white/80">
                          {selectedConcept.eventType} • Revision v{activeRevision.version}
                        </span>
                      </div>
                      <h3
                        data-testid="concept-theme-name"
                        className="font-serif text-2xl sm:text-3xl mt-1.5"
                      >
                        {activeRevision.themeName}
                      </h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[11px] text-white/75">
                        <span className="font-mono" data-testid="concept-persistence-id">
                          Proposal ID: {selectedConcept.id}
                        </span>
                        <span data-testid="concept-revision-timestamp">
                          Saved: {formatRevisionTimestamp(activeRevision.createdAt)}
                        </span>
                      </div>
                    </div>

                    {selectedConcept.revisions.length > 1 && (
                      <div className="flex items-center gap-1.5 bg-white/10 p-1 rounded-lg">
                        <History className="w-3.5 h-3.5 ml-1.5 text-[var(--cs-gold-light)]" />
                        {selectedConcept.revisions.map((rev, idx) => (
                          <button
                            key={rev.version}
                            type="button"
                            onClick={() => setActiveRevisionIndex(idx)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                              activeRevisionIndex === idx
                                ? 'bg-white text-[var(--cs-purple)]'
                                : 'text-white/80 hover:text-white'
                            }`}
                          >
                            v{rev.version}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-6 sm:p-8 space-y-6">
                    <p
                      data-testid="concept-vision-summary"
                      className="text-sm text-[var(--cs-charcoal)] leading-relaxed bg-[var(--cs-cream)] p-4 rounded-xl border border-[var(--cs-border)]"
                    >
                      {activeRevision.visionSummary}
                    </p>

                    {/* Color Palette Swatches */}
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--cs-gold)] mb-3">
                        Curated Color Palette
                      </p>
                      <div
                        data-testid="concept-color-palette"
                        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
                      >
                        {activeRevision.colorPalette.map((swatch) => (
                          <div
                            key={`${swatch.name}-${swatch.hex}`}
                            className="rounded-xl border border-[var(--cs-border)] overflow-hidden bg-white"
                          >
                            <div
                              className="h-16 w-full border-b border-[var(--cs-border)]"
                              style={{ backgroundColor: swatch.hex }}
                              aria-label={`${swatch.name} swatch ${swatch.hex}`}
                            />
                            <div className="p-2.5">
                              <p className="text-xs font-semibold text-[var(--cs-charcoal)]">
                                {swatch.name}
                              </p>
                              <p className="text-[10px] font-mono text-[var(--cs-charcoal-light)]">
                                {swatch.hex}
                              </p>
                              <p className="text-[11px] text-[var(--cs-charcoal-light)] mt-1 leading-snug">
                                {swatch.usage}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Design Architecture Grid */}
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                          Floral Concept
                        </p>
                        <p
                          data-testid="concept-floral-concept"
                          className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                        >
                          {activeRevision.floralConcept}
                        </p>
                      </div>
                      {activeRevision.centerpieceDesign && (
                        <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                            Centerpiece Design
                          </p>
                          <p
                            data-testid="concept-centerpiece-design"
                            className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                          >
                            {activeRevision.centerpieceDesign}
                          </p>
                        </div>
                      )}
                      <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                          Table Arrangement
                        </p>
                        <p
                          data-testid="concept-table-arrangement"
                          className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                        >
                          {activeRevision.tableArrangement}
                        </p>
                      </div>
                      <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                          Stage & Backdrop
                        </p>
                        <p
                          data-testid="concept-stage-backdrop"
                          className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                        >
                          {activeRevision.stageBackdrop}
                        </p>
                      </div>
                      <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                          Lighting Plan
                        </p>
                        <p
                          data-testid="concept-lighting-plan"
                          className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                        >
                          {activeRevision.lightingPlan}
                        </p>
                      </div>
                      {activeRevision.venueStyling && (
                        <div className="p-4 rounded-xl border border-[var(--cs-border)]">
                          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                            Venue Styling
                          </p>
                          <p
                            data-testid="concept-venue-styling"
                            className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                          >
                            {activeRevision.venueStyling}
                          </p>
                        </div>
                      )}
                      {activeRevision.guestExperience && (
                        <div className="p-4 rounded-xl border border-[var(--cs-border)] sm:col-span-2">
                          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--cs-purple)] mb-1.5">
                            Proposed Guest Experience
                          </p>
                          <p
                            data-testid="concept-guest-experience"
                            className="text-sm text-[var(--cs-charcoal-light)] leading-relaxed"
                          >
                            {activeRevision.guestExperience}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Recommended Service Divisions */}
                    {Array.isArray(activeRevision.recommendedDivisions) &&
                      activeRevision.recommendedDivisions.length > 0 && (
                        <div className="p-4 rounded-xl bg-[var(--cs-cream)]/60 border border-[var(--cs-border)]">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--cs-purple)] flex items-center gap-1.5 mb-2.5">
                            <Layers className="w-3.5 h-3.5 text-[var(--cs-gold)]" />
                            Recommended Service Divisions
                          </p>
                          <div
                            data-testid="concept-recommended-divisions"
                            className="flex flex-wrap gap-2"
                          >
                            {activeRevision.recommendedDivisions.map((division) => (
                              <span
                                key={division}
                                className="text-xs px-3 py-1.5 rounded-lg bg-white border border-[var(--cs-border)] text-[var(--cs-purple)] font-medium"
                              >
                                {division}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                    {/* Dual Approval Workflow Bar */}
                    <div className="pt-5 border-t border-[var(--cs-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium ${
                            selectedConcept.clientApproved
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Client Approved: {selectedConcept.clientApproved ? 'Yes' : 'Pending'}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium ${
                            selectedConcept.staffApproved
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Lead Designer Approved:{' '}
                          {selectedConcept.staffApproved ? 'Yes' : 'Pending'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onOpenBookingPrefilled({
                              eventType: selectedConcept.eventType,
                              guestCount: conceptForm.guestCount,
                              notes: `Concept Studio Proposal (${selectedConcept.id} v${activeRevision.version}): ${activeRevision.themeName} — ${activeRevision.visionSummary}`,
                            })
                          }
                          className="px-4 py-2 rounded-lg border border-[var(--cs-purple)] text-[var(--cs-purple)] text-xs font-semibold hover:bg-[var(--cs-purple)]/5 transition-colors"
                        >
                          Book Consultation with This Concept
                        </button>
                        {currentUser.role !== 'guest' && (
                          <button
                            type="button"
                            disabled={approvalSaving}
                            onClick={() => void handleApproveConcept()}
                            className="px-4 py-2 rounded-lg bg-[var(--cs-purple)] text-white text-xs font-semibold hover:bg-[var(--cs-purple-dark)] disabled:opacity-50 transition-colors"
                          >
                            {approvalSaving
                              ? 'Recording...'
                              : currentUser.role === 'client'
                                ? 'Approve Design Direction'
                                : 'Record Staff Creative Sign-Off'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-12 rounded-2xl border border-dashed border-[var(--cs-border)] text-center text-sm text-[var(--cs-charcoal-light)]">
                  Compose your celebration vision on the left to generate a structured luxury mood
                  board.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
