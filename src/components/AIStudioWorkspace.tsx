import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Palette,
  Send,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { SERVICE_DIVISIONS } from '../data/brandCatalog';
import type { DesignConceptRecord, UserSession } from '../types/domain';

interface AIStudioWorkspaceProps {
  currentUser: UserSession;
  onOpenBookingPrefilled: (prefill: {
    eventType?: string;
    location?: string;
    guestCount?: number;
    notes?: string;
  }) => void;
}

interface ConciergeMessage {
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

const QUICK_PROMPTS = [
  'We are planning an autumn wedding for 180 guests in Columbia, SC with ivory florals and royal purple accents.',
  'Looking for corporate gala lighting, stage design, and banquet tablescapes for 300 guests in January.',
  'Planning an intimate garden baby shower for 45 guests near Lake Murray with a portrait photo booth.',
];

export function AIStudioWorkspace({ currentUser, onOpenBookingPrefilled }: AIStudioWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<'concierge' | 'concept'>('concierge');

  // AI Concierge state
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ConciergeMessage[]>([
    {
      role: 'assistant',
      content:
        'Welcome to Celebration Sisters Event Decor in Columbia, South Carolina. Tell me a little about the celebration you are envisioning—such as your event type, preferred date, location, and guest count—and I will guide you toward tailored service recommendations.',
    },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [extractedLead, setExtractedLead] = useState<ExtractedLead | null>(null);

  // AI Concept Studio state
  const [concepts, setConcepts] = useState<DesignConceptRecord[]>([]);
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [conceptEventType, setConceptEventType] = useState(SERVICE_DIVISIONS[0].title);
  const [conceptGuests, setConceptGuests] = useState(150);
  const [conceptVenueStyle, setConceptVenueStyle] = useState('Historic Estate Ballroom');
  const [conceptPalette, setConceptPalette] = useState('Royal Purple, Champagne Gold & Soft Ivory');
  const [conceptVision, setConceptVision] = useState(
    'Candlelit tables with elevated ivory garden roses, gold charger plates, and warm architectural uplighting.',
  );
  const [conceptLoading, setConceptLoading] = useState(false);
  const [conceptError, setConceptError] = useState<string | null>(null);
  const [activeRevisionIndex, setActiveRevisionIndex] = useState(0);

  useEffect(() => {
    const loadConcepts = async () => {
      try {
        const res = await fetch('/api/concepts', {
          headers: { 'x-user-id': currentUser.id },
        });
        if (!res.ok) return;
        const data = await res.json();
        setConcepts(data.concepts || []);
        if (data.concepts?.length > 0 && !selectedConceptId) {
          setSelectedConceptId(data.concepts[0].id);
        }
      } catch {
        // Silent initial load
      }
    };
    loadConcepts();
  }, [currentUser.id, selectedConceptId]);

  const sendConciergeMessage = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed || chatLoading) return;

    setChatError(null);
    const nextHistory: ConciergeMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextHistory);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/ai/concierge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': currentUser.id,
        },
        body: JSON.stringify({
          sessionId,
          clientName: currentUser.role !== 'guest' ? currentUser.name : undefined,
          message: trimmed,
          history: messages,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'AI Event Concierge is currently unavailable.');
      }
      setSessionId(data.sessionId);
      setMessages([...nextHistory, { role: 'assistant', content: data.reply }]);
      setExtractedLead(data.extractedLead);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Unable to reach AI Concierge.');
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendConciergeMessage(chatInput);
  };

  const handleGenerateConcept = async (e: FormEvent, reviseExisting = false) => {
    e.preventDefault();
    setConceptLoading(true);
    setConceptError(null);

    try {
      const res = await fetch('/api/ai/concept-studio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': currentUser.id,
        },
        body: JSON.stringify({
          conceptId: reviseExisting && selectedConceptId ? selectedConceptId : undefined,
          eventType: conceptEventType,
          guestCount: Number(conceptGuests),
          venueStyle: conceptVenueStyle,
          preferredPalette: conceptPalette,
          visionDescription: conceptVision,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Unable to generate concept proposal.');
      }
      const created: DesignConceptRecord = data.concept;
      setConcepts((prev) => {
        const exists = prev.some((c) => c.id === created.id);
        return exists ? prev.map((c) => (c.id === created.id ? created : c)) : [created, ...prev];
      });
      setSelectedConceptId(created.id);
      setActiveRevisionIndex(0);
    } catch (err) {
      setConceptError(err instanceof Error ? err.message : 'Concept generation failed.');
    } finally {
      setConceptLoading(false);
    }
  };

  const handleApproveConcept = async (conceptId: string) => {
    try {
      const res = await fetch(`/api/concepts/${conceptId}/approve`, {
        method: 'POST',
        headers: { 'x-user-id': currentUser.id },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Approval failed.');
      setConcepts((prev) => prev.map((c) => (c.id === conceptId ? data.concept : c)));
    } catch (err) {
      setConceptError(err instanceof Error ? err.message : 'Approval error.');
    }
  };

  const activeConcept = concepts.find((c) => c.id === selectedConceptId) || concepts[0];
  const activeRevision = activeConcept?.revisions[activeRevisionIndex] || activeConcept?.revisions[0];

  return (
    <div className="bg-[var(--cs-ivory)] min-h-[82vh] py-12 text-[var(--cs-charcoal)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Studio Header & Mode Switch */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-[var(--cs-border)] pb-6">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--cs-gold-muted)] uppercase">
              Intelligent Planning Suite
            </p>
            <h1 className="font-display text-3xl sm:text-4xl font-semibold text-[var(--cs-purple)]">
              AI Event Concierge & Concept Studio
            </h1>
          </div>

          <div className="inline-flex bg-white border border-[var(--cs-border)] p-1 rounded-lg self-start">
            <button
              type="button"
              onClick={() => setActiveTab('concierge')}
              className={`px-4 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'concierge'
                  ? 'bg-[var(--cs-purple)] text-white'
                  : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              AI Event Concierge
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('concept')}
              className={`px-4 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'concept'
                  ? 'bg-[var(--cs-purple)] text-white'
                  : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
              }`}
            >
              <Palette className="w-3.5 h-3.5" />
              AI Concept Studio
            </button>
          </div>
        </div>

        {activeTab === 'concierge' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Purple & Ivory Chat Workspace */}
            <div className="lg:col-span-8 bg-white border border-[var(--cs-border)] rounded-lg overflow-hidden flex flex-col">
              <div className="bg-[var(--cs-purple)] text-white px-6 py-4 flex items-center justify-between gap-4 border-b border-[var(--cs-gold)]/40">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-4 h-4 text-[#E6C98F]" />
                  <div>
                    <h2 className="font-display text-base font-semibold">Celebration Sisters AI Concierge</h2>
                    <p className="text-[11px] text-white/80">
                      Guided discovery · Preliminary service matching · Human planner escalation
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onOpenBookingPrefilled({
                      eventType: extractedLead?.eventCategory !== 'Unknown' ? extractedLead?.eventCategory : undefined,
                      location: extractedLead?.location,
                      guestCount: extractedLead?.guestCount ?? undefined,
                      notes: extractedLead?.summary,
                    })
                  }
                  className="px-3.5 py-1.5 text-xs font-medium bg-white text-[var(--cs-purple)] hover:bg-[var(--cs-ivory)] rounded-md whitespace-nowrap cursor-pointer"
                >
                  Request Human Consultation
                </button>
              </div>

              {/* Conversation History */}
              <div className="p-6 space-y-4 h-[420px] overflow-y-auto bg-[var(--cs-ivory)]/45">
                {messages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-[var(--cs-purple)] text-white'
                          : 'bg-white border border-[var(--cs-border)] text-[var(--cs-charcoal)]'
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}

                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-[var(--cs-border)] rounded-lg px-4 py-3 text-xs text-[var(--cs-charcoal-muted)] inline-flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--cs-purple)]" />
                      <span>Composing tailored recommendations...</span>
                    </div>
                  </div>
                )}

                {chatError && (
                  <div className="p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{chatError}</span>
                  </div>
                )}
              </div>

              {/* Quick Prompts */}
              <div className="px-6 py-3 bg-[var(--cs-ivory)] border-t border-[var(--cs-border)] flex flex-wrap gap-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => sendConciergeMessage(q)}
                    disabled={chatLoading}
                    className="text-left text-[11px] px-3 py-1.5 bg-white border border-[var(--cs-border)] hover:border-[var(--cs-gold)] rounded-md text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] transition-colors cursor-pointer"
                  >
                    {q.slice(0, 56)}...
                  </button>
                ))}
              </div>

              {/* Input Bar */}
              <form onSubmit={handleChatSubmit} className="p-4 bg-white border-t border-[var(--cs-border)] flex gap-3">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Describe your celebration date, location, guest count, or aesthetic..."
                  className="flex-1 px-4 py-2.5 text-sm border border-[var(--cs-border-strong)] rounded-md focus:border-[var(--cs-purple)] outline-none"
                />
                <button
                  type="submit"
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] disabled:opacity-50 rounded-md inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  Send
                </button>
              </form>
            </div>

            {/* Right Panel: Live Captured Lead Brief & Guardrails */}
            <aside className="lg:col-span-4 space-y-6">
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                  Captured Discovery Profile
                </h3>
                {extractedLead ? (
                  <div className="space-y-3 text-xs">
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Category</span>
                      <span className="font-medium text-right">{extractedLead.eventCategory}</span>
                    </div>
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Target Date</span>
                      <span className="font-medium tabular-nums">{extractedLead.eventDate}</span>
                    </div>
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Location</span>
                      <span className="font-medium">{extractedLead.location}</span>
                    </div>
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Guest Count</span>
                      <span className="font-medium tabular-nums">
                        {extractedLead.guestCount ?? 'Unspecified'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Theme</span>
                      <span className="font-medium text-right">{extractedLead.theme}</span>
                    </div>
                    <div className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]">
                      <span className="text-[var(--cs-charcoal-muted)]">Budget Range</span>
                      <span className="font-medium text-right">{extractedLead.budgetRange}</span>
                    </div>

                    {extractedLead.recommendedDivisions.length > 0 && (
                      <div className="pt-1 space-y-1.5">
                        <p className="text-[var(--cs-charcoal-muted)] font-medium">Recommended Divisions</p>
                        <ul className="space-y-1 text-[var(--cs-purple)] font-medium">
                          {extractedLead.recommendedDivisions.map((d) => (
                            <li key={d}>· {d}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() =>
                          onOpenBookingPrefilled({
                            eventType: extractedLead.eventCategory,
                            location: extractedLead.location,
                            guestCount: extractedLead.guestCount ?? 100,
                            notes: extractedLead.summary,
                          })
                        }
                        className="w-full py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                      >
                        Convert Profile to Consultation Inquiry
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--cs-charcoal-muted)] leading-relaxed">
                    As you chat with the Concierge, your event category, guest count, location, and recommended service divisions will populate here for seamless planner handoff.
                  </p>
                )}
              </div>

              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-2 text-xs text-[var(--cs-charcoal-muted)]">
                <p className="font-semibold text-[var(--cs-purple)]">Consultation Governance</p>
                <p className="leading-relaxed">
                  The AI Concierge provides discovery guidance only. Binding quotations, date availability verification, contracts, and payments are confirmed strictly by Celebration Sisters staff via secure backend workflows.
                </p>
              </div>
            </aside>
          </div>
        ) : (
          /* AI Event Concept Studio */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Vision Input Form */}
            <form
              onSubmit={(e) => handleGenerateConcept(e, false)}
              className="lg:col-span-4 bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4"
            >
              <div className="space-y-1">
                <h2 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                  Compose Design Vision
                </h2>
                <p className="text-xs text-[var(--cs-charcoal-muted)]">
                  Describe your room, palette, and mood in plain language.
                </p>
              </div>

              {conceptError && (
                <div className="p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
                  {conceptError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1">Celebration Division</label>
                <select
                  value={conceptEventType}
                  onChange={(e) => setConceptEventType(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                >
                  {SERVICE_DIVISIONS.map((d) => (
                    <option key={d.id} value={d.title}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Guest Count</label>
                  <input
                    type="number"
                    min={10}
                    max={1500}
                    value={conceptGuests}
                    onChange={(e) => setConceptGuests(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Venue Architecture</label>
                  <input
                    type="text"
                    value={conceptVenueStyle}
                    onChange={(e) => setConceptVenueStyle(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Preferred Palette & Metals</label>
                <input
                  type="text"
                  value={conceptPalette}
                  onChange={(e) => setConceptPalette(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Dream Event Description</label>
                <textarea
                  rows={4}
                  value={conceptVision}
                  onChange={(e) => setConceptVision(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="submit"
                  disabled={conceptLoading}
                  className="w-full py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  {conceptLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {conceptLoading ? 'Composing Proposal...' : 'Create New Concept Proposal'}
                </button>
                {activeConcept && (
                  <button
                    type="button"
                    disabled={conceptLoading}
                    onClick={(e) => handleGenerateConcept(e, true)}
                    className="w-full py-2 text-xs font-medium text-[var(--cs-purple)] border border-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md cursor-pointer"
                  >
                    Save as Revision v{activeConcept.currentVersion + 1} on Current Board
                  </button>
                )}
              </div>
            </form>

            {/* Mood Board & Dual Approval Canvas */}
            <div className="lg:col-span-8 space-y-6">
              {activeConcept && activeRevision ? (
                <div className="bg-white border border-[var(--cs-border)] rounded-lg overflow-hidden">
                  {/* Mandatory Conceptual Visualization Notice */}
                  <div className="bg-[var(--cs-purple)] text-white px-6 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-[#E6C98F]">
                      Conceptual Visualization · Not an Actual Event Portfolio Photograph
                    </span>
                    <div className="flex items-center gap-2">
                      {activeConcept.revisions.map((rev, idx) => (
                        <button
                          key={rev.version}
                          type="button"
                          onClick={() => setActiveRevisionIndex(idx)}
                          className={`px-2.5 py-1 rounded text-[11px] tabular-nums cursor-pointer ${
                            activeRevisionIndex === idx
                              ? 'bg-white text-[var(--cs-purple)] font-semibold'
                              : 'bg-white/15 text-white hover:bg-white/25'
                          }`}
                        >
                          Rev v{rev.version}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-6 sm:p-8 space-y-8">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-[var(--cs-border)] pb-6">
                      <div className="space-y-1.5">
                        <p className="text-xs text-[var(--cs-gold-muted)] font-medium">
                          {activeConcept.eventType} · Revision {activeRevision.version}
                        </p>
                        <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--cs-purple)]">
                          {activeRevision.themeName}
                        </h2>
                        <p className="text-sm text-[var(--cs-charcoal-muted)] leading-relaxed max-w-2xl">
                          {activeRevision.visionSummary}
                        </p>
                      </div>
                    </div>

                    {/* Visual Color Harmony Swatches */}
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold tracking-wider text-[var(--cs-purple)] uppercase">
                        Curated Color & Material Palette
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {activeRevision.colorPalette.map((swatch) => (
                          <div key={swatch.name} className="border border-[var(--cs-border)] rounded-md overflow-hidden">
                            <div
                              className="h-16 w-full border-b border-[var(--cs-border)]"
                              style={{ backgroundColor: swatch.hex }}
                            />
                            <div className="p-3 space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="font-semibold text-[var(--cs-charcoal)]">{swatch.name}</span>
                                <span className="font-mono text-[11px] text-[var(--cs-charcoal-muted)]">{swatch.hex}</span>
                              </div>
                              <p className="text-[11px] text-[var(--cs-charcoal-muted)] leading-snug">{swatch.usage}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Architectural Concept Specs */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md p-5 space-y-1.5">
                        <h4 className="font-display text-base font-semibold text-[var(--cs-purple)]">
                          Floral Architecture
                        </h4>
                        <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                          {activeRevision.floralConcept}
                        </p>
                      </div>
                      <div className="bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md p-5 space-y-1.5">
                        <h4 className="font-display text-base font-semibold text-[var(--cs-purple)]">
                          Tablescape Arrangement
                        </h4>
                        <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                          {activeRevision.tableArrangement}
                        </p>
                      </div>
                      <div className="bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md p-5 space-y-1.5">
                        <h4 className="font-display text-base font-semibold text-[var(--cs-purple)]">
                          Stage & Focal Backdrop
                        </h4>
                        <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                          {activeRevision.stageBackdrop}
                        </p>
                      </div>
                      <div className="bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md p-5 space-y-1.5">
                        <h4 className="font-display text-base font-semibold text-[var(--cs-purple)]">
                          Lighting Calibration
                        </h4>
                        <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                          {activeRevision.lightingPlan}
                        </p>
                      </div>
                    </div>

                    {/* Dual Approval Workflow Bar */}
                    <div className="border-t border-[var(--cs-border)] pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1 text-xs">
                        <p className="font-semibold text-[var(--cs-purple)]">
                          Dual Approval Status:{' '}
                          {activeConcept.clientApproved && activeConcept.staffApproved
                            ? 'Fully Approved for Production'
                            : 'Awaiting Required Signatures'}
                        </p>
                        <p className="text-[var(--cs-charcoal-muted)]">
                          Client Approval: {activeConcept.clientApproved ? 'Approved' : 'Pending'} · Lead Designer Approval:{' '}
                          {activeConcept.staffApproved ? `Approved (${activeConcept.staffApprovedBy})` : 'Pending'}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        {currentUser.role !== 'guest' && currentUser.role !== 'vendor' ? (
                          <button
                            type="button"
                            onClick={() => handleApproveConcept(activeConcept.id)}
                            className="px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            {activeConcept.clientApproved && activeConcept.staffApproved ? (
                              <CheckCircle2 className="w-4 h-4" />
                            ) : (
                              <UserCheck className="w-4 h-4" />
                            )}
                            Record {currentUser.role === 'client' ? 'Client' : 'Staff Designer'} Approval
                          </button>
                        ) : (
                          <span className="text-xs text-[var(--cs-charcoal-muted)]">
                            Sign in under Portals to record client or designer approval.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-12 text-center text-sm text-[var(--cs-charcoal-muted)]">
                  Compose your celebration vision on the left to generate a structured luxury mood board.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
