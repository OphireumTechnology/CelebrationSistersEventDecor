import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Bell,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  History,
  RefreshCw,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  CRM_PIPELINE_STAGES,
  type AuditLogEntry,
  type BlackoutDate,
  type ConsultationAppointment,
  type ConsultationMethod,
  type CrmFollowUpTask,
  type OutboxNotificationJob,
  type StaffAvailabilityRule,
  type UserRole,
} from '../types/domain';
import { apiFetch } from '../lib/apiClient';

interface ConsultationMetrics {
  total: number;
  newRequests: number;
  pending: number;
  confirmed: number;
  rescheduled: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  noShow: number;
  overdueFollowUps: number;
}

interface PlannerOption {
  id: string;
  name: string;
  role: UserRole;
  email: string;
}

interface CommandCenterPayload {
  consultations: ConsultationAppointment[];
  metrics: ConsultationMetrics;
  planners: PlannerOption[];
  staffAvailabilityRules: StaffAvailabilityRule[];
  crmFollowUpTasks: CrmFollowUpTask[];
  blackoutDates: BlackoutDate[];
  notificationOutbox: OutboxNotificationJob[];
  auditLogs: AuditLogEntry[];
}

interface AdminConsultationCommandCenterProps {
  currentRole: UserRole;
  onWorkspaceRefresh?: () => Promise<void>;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatUtcEt(utcIso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(utcIso));
  } catch {
    return utcIso;
  }
}

function formatMethod(method: ConsultationMethod): string {
  if (method === 'in_person_columbia') return 'In-Person (Columbia)';
  if (method === 'phone') return 'Phone';
  return 'Video';
}

export function AdminConsultationCommandCenter({
  currentRole,
  onWorkspaceRefresh,
}: AdminConsultationCommandCenterProps) {
  const [section, setSection] = useState<
    'calendar' | 'crm' | 'staff' | 'proposals' | 'notifications' | 'audit'
  >('calendar');
  const [calendarMode, setCalendarMode] = useState<'day' | 'week' | 'month'>('week');
  const [anchorDate, setAnchorDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [plannerFilter, setPlannerFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');

  const [data, setData] = useState<CommandCenterPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');

  // Inline action states
  const [outcomeSummary, setOutcomeSummary] = useState('');
  const [outcomeStatus, setOutcomeStatus] = useState<'Completed' | 'No-show'>('Completed');
  const [followUpTitle, setFollowUpTitle] = useState('Prepare customized decor proposal & linen board');
  const [followUpDays, setFollowUpDays] = useState(2);

  // Proposal Handoff state
  const [proposalItems, setProposalItems] = useState<
    Array<{ description: string; quantity: number; unitPrice: number }>
  >([
    { description: 'Full-Service Luxury Decor & Floral Architecture', quantity: 1, unitPrice: 12500 },
    { description: 'Custom Candlelight, Drapery & Head Table Staging', quantity: 1, unitPrice: 4800 },
  ]);
  const [proposalDiscount, setProposalDiscount] = useState(0);
  const [proposalNotes, setProposalNotes] = useState(
    'Includes Columbia studio design curation, installation crew, and post-event strike.',
  );

  // New CRM task state
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState(() => {
    const dt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    return dt.toISOString().slice(0, 10);
  });

  // Staff availability editor state
  const [editingPlannerId, setEditingPlannerId] = useState<string>('');
  const [editableRules, setEditableRules] = useState<
    Array<{
      dayOfWeek: number;
      startTimeLocal: string;
      endTimeLocal: string;
      slotDurationMinutes: number;
      bufferBeforeMinutes: number;
      bufferAfterMinutes: number;
      allowedMethods: ConsultationMethod[];
      isActive: boolean;
    }>
  >([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/consultations', { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'err', text: json.error || 'Unable to load consultation command center.' });
        return;
      }
      setData(json as CommandCenterPayload);
      const list: ConsultationAppointment[] = json.consultations || [];
      if (list.length > 0 && !list.some((c) => c.id === selectedId)) {
        setSelectedId(list[0].id);
      }
      const planners: PlannerOption[] = json.planners || [];
      if (planners.length > 0 && !editingPlannerId) {
        setEditingPlannerId(planners[0].id);
      }
    } catch {
      setFeedback({ type: 'err', text: 'Connection error loading consultations.' });
    } finally {
      setLoading(false);
    }
  }, [selectedId, editingPlannerId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Sync editable availability rules whenever selected planner changes
  useEffect(() => {
    if (!data || !editingPlannerId) return;
    const existing = data.staffAvailabilityRules.filter((r) => r.plannerId === editingPlannerId);
    const fullWeek = DAY_NAMES.map((_, dow) => {
      const match = existing.find((r) => r.dayOfWeek === dow);
      return match
        ? {
            dayOfWeek: dow,
            startTimeLocal: match.startTimeLocal,
            endTimeLocal: match.endTimeLocal,
            slotDurationMinutes: match.slotDurationMinutes,
            bufferBeforeMinutes: match.bufferBeforeMinutes,
            bufferAfterMinutes: match.bufferAfterMinutes,
            allowedMethods: match.allowedMethods,
            isActive: match.isActive,
          }
        : {
            dayOfWeek: dow,
            startTimeLocal: '10:00',
            endTimeLocal: '17:00',
            slotDurationMinutes: 45,
            bufferBeforeMinutes: 15,
            bufferAfterMinutes: 15,
            allowedMethods: ['video', 'in_person_columbia', 'phone'] as ConsultationMethod[],
            isActive: false,
          };
    });
    setEditableRules(fullWeek);
  }, [data, editingPlannerId]);

  const filteredConsultations = useMemo(() => {
    if (!data) return [];
    const q = searchQuery.trim().toLowerCase();
    return data.consultations.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (plannerFilter && c.assignedPlannerId !== plannerFilter) return false;
      if (
        q &&
        !`${c.referenceCode} ${c.clientName} ${c.clientEmail} ${c.eventTitle} ${c.venueName}`
          .toLowerCase()
          .includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [data, statusFilter, plannerFilter, searchQuery]);

  const calendarConsultations = useMemo(() => {
    const baseMs = new Date(`${anchorDate}T00:00:00Z`).getTime();
    const spanDays = calendarMode === 'day' ? 1 : calendarMode === 'week' ? 7 : 31;
    const endMs = baseMs + spanDays * 24 * 60 * 60_000;
    return filteredConsultations.filter((c) => {
      const startMs = new Date(c.startUtc).getTime();
      return startMs >= baseMs - 12 * 60 * 60_000 && startMs <= endMs + 12 * 60 * 60_000;
    });
  }, [filteredConsultations, anchorDate, calendarMode]);

  const selectedConsultation =
    data?.consultations.find((c) => c.id === selectedId) || filteredConsultations[0] || null;

  const proposalPreview = useMemo(() => {
    const subtotalCents = proposalItems.reduce(
      (sum, item) => sum + Math.round(item.unitPrice * 100) * Math.max(1, item.quantity),
      0,
    );
    const discountCents = Math.round(Math.max(0, proposalDiscount) * 100);
    const totalCents = Math.max(0, subtotalCents - discountCents);
    return { subtotalCents, discountCents, totalCents };
  }, [proposalItems, proposalDiscount]);

  const runAction = async (
    url: string,
    method: 'POST' | 'PATCH' | 'PUT',
    body: Record<string, unknown> | undefined,
    successText: string,
  ) => {
    setFeedback(null);
    const res = await apiFetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFeedback({ type: 'err', text: json.error || 'Action failed.' });
      return false;
    }
    setFeedback({ type: 'ok', text: successText });
    await loadData();
    await onWorkspaceRefresh?.();
    return true;
  };

  const handleCompleteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedConsultation || outcomeSummary.trim().length < 5) {
      setFeedback({ type: 'err', text: 'Please enter a consultation outcome summary (at least 5 characters).' });
      return;
    }
    const dueIso = new Date(Date.now() + Math.max(1, followUpDays) * 24 * 60 * 60_000).toISOString();
    const ok = await runAction(
      `/api/consultations/${selectedConsultation.id}/complete`,
      'POST',
      {
        status: outcomeStatus,
        outcomeSummary: outcomeSummary.trim(),
        followUpTitle: followUpTitle.trim() || undefined,
        followUpDueAt: dueIso,
      },
      `Consultation ${selectedConsultation.referenceCode} marked ${outcomeStatus} and CRM updated.`,
    );
    if (ok) setOutcomeSummary('');
  };

  const handleProposalHandoff = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedConsultation) return;
    await runAction(
      `/api/consultations/${selectedConsultation.id}/proposal-handoff`,
      'POST',
      {
        lineItems: proposalItems.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unitPriceCents: Math.round(i.unitPrice * 100),
        })),
        discountCents: Math.round(Math.max(0, proposalDiscount) * 100),
        notes: proposalNotes,
        markAsSent: true,
      },
      `Itemized proposal issued for ${selectedConsultation.referenceCode} and moved to Proposal Sent.`,
    );
  };

  const handleSaveStaffSchedule = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingPlannerId) return;
    const activeRules = editableRules.filter((r) => r.isActive);
    await runAction(
      `/api/staff/availability/${editingPlannerId}`,
      'PUT',
      { rules: activeRules },
      `Updated weekly availability schedule (${activeRules.length} active days).`,
    );
  };

  const handleCreateTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedConsultation || newTaskTitle.trim().length < 3) return;
    const ok = await runAction(
      '/api/crm/tasks',
      'POST',
      {
        consultationId: selectedConsultation.id,
        title: newTaskTitle.trim(),
        dueAt: new Date(`${newTaskDueDate}T17:00:00Z`).toISOString(),
      },
      'Follow-up task added to CRM pipeline.',
    );
    if (ok) setNewTaskTitle('');
  };

  const metrics = data?.metrics;

  return (
    <div className="space-y-6">
      {/* KPI Overview Strip */}
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { label: 'Total Requests', value: metrics.total },
            { label: 'Pending Review', value: metrics.pending },
            { label: 'Confirmed', value: metrics.confirmed },
            { label: 'Upcoming', value: metrics.upcoming },
            { label: 'Completed', value: metrics.completed },
            { label: 'Cancelled', value: metrics.cancelled },
            { label: 'Overdue Tasks', value: metrics.overdueFollowUps, warn: metrics.overdueFollowUps > 0 },
          ].map((kpi) => (
            <div key={kpi.label} className="bg-white border border-[var(--cs-border)] rounded-lg p-4">
              <p className="text-[11px] text-[var(--cs-charcoal-muted)]">{kpi.label}</p>
              <p
                className={`font-display text-2xl font-semibold tabular-nums mt-1 ${
                  kpi.warn ? 'text-amber-700' : 'text-[var(--cs-purple)]'
                }`}
              >
                {kpi.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Command Center Sub-Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[var(--cs-border)] p-2 rounded-lg">
        <div className="flex flex-wrap gap-1">
          {[
            { id: 'calendar', label: 'Schedule & Calendar', icon: Calendar },
            { id: 'crm', label: 'CRM Conversion Pipeline', icon: TrendingUp },
            { id: 'proposals', label: 'Proposal Handoff', icon: FileText },
            { id: 'staff', label: 'Staff Availability', icon: UserCheck },
            { id: 'notifications', label: 'Email Outbox', icon: Bell },
            { id: 'audit', label: 'Audit History', icon: History },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id as typeof section)}
              className={`min-h-[40px] px-3 py-2 text-xs font-medium rounded-md inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                section === tab.id
                  ? 'bg-[var(--cs-purple)] text-white'
                  : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          className="min-h-[38px] px-3 py-1.5 text-xs border border-[var(--cs-border-strong)] rounded-md text-[var(--cs-purple)] hover:bg-[var(--cs-ivory)] inline-flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {feedback && (
        <div
          role={feedback.type === 'err' ? 'alert' : 'status'}
          aria-live="polite"
          className={`p-3.5 rounded-md text-xs font-medium border ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* 1. SCHEDULE & CALENDAR VIEW */}
      {section === 'calendar' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border)] pb-3">
              <div>
                <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                  Consultation Calendar & Queue
                </h3>
                <p className="text-xs text-[var(--cs-charcoal-muted)]">
                  Filter by status, planner, or view Day / Week / Month schedule windows.
                </p>
              </div>
              <div className="flex items-center gap-1 border border-[var(--cs-border)] rounded-md p-0.5">
                {(['day', 'week', 'month'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCalendarMode(m)}
                    className={`px-2.5 py-1 text-xs font-medium rounded capitalize cursor-pointer ${
                      calendarMode === m
                        ? 'bg-[var(--cs-purple)] text-white'
                        : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search client, ref, event..."
                className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
              >
                <option value="">All Statuses</option>
                <option value="Pending">Pending</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Rescheduled">Rescheduled</option>
                <option value="Completed">Completed</option>
                <option value="Cancelled">Cancelled</option>
                <option value="No-show">No-show</option>
              </select>
              <select
                value={plannerFilter}
                onChange={(e) => setPlannerFilter(e.target.value)}
                className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
              >
                <option value="">All Planners</option>
                {data?.planners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                aria-label="Calendar window start date"
                className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
              />
            </div>

            <div className="space-y-2.5">
              {(calendarConsultations.length > 0 ? calendarConsultations : filteredConsultations).map((c) => {
                const isSelected = selectedConsultation?.id === c.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`p-4 rounded-md border cursor-pointer space-y-1.5 transition-colors ${
                      isSelected
                        ? 'border-[var(--cs-purple)] bg-[var(--cs-purple-soft)]/45'
                        : 'border-[var(--cs-border)] hover:border-[var(--cs-gold)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--cs-purple)] tabular-nums">
                        {c.referenceCode} · {c.status} · {c.crmStage}
                      </span>
                      <span className="text-[11px] font-medium text-[var(--cs-charcoal-muted)] tabular-nums">
                        {formatUtcEt(c.startUtc)}
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-[var(--cs-charcoal)]">{c.eventTitle}</p>
                    <p className="text-xs text-[var(--cs-charcoal-muted)]">
                      Client: {c.clientName} · {formatMethod(c.method)} · Planner: {c.assignedPlannerName} · Event: {c.eventDate}
                    </p>
                  </div>
                );
              })}
              {filteredConsultations.length === 0 && (
                <p className="text-xs text-[var(--cs-charcoal-muted)] py-6 text-center">
                  No consultations match the current filters.
                </p>
              )}
            </div>
          </div>

          {/* Right Column: Selected Consultation Operations Drawer */}
          <div className="lg:col-span-5 bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-5">
            {selectedConsultation ? (
              <>
                <div className="border-b border-[var(--cs-border)] pb-3">
                  <p className="text-xs font-medium text-[var(--cs-gold-muted)] tabular-nums">
                    {selectedConsultation.referenceCode} · {selectedConsultation.status}
                  </p>
                  <h4 className="font-display text-lg font-semibold text-[var(--cs-purple)] mt-0.5">
                    {selectedConsultation.eventTitle}
                  </h4>
                  <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                    {selectedConsultation.clientName} · {selectedConsultation.clientEmail} · {selectedConsultation.clientPhone}
                  </p>
                </div>

                <dl className="grid grid-cols-2 gap-3 text-xs bg-[var(--cs-ivory)] p-3.5 rounded-md border border-[var(--cs-border)]">
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Scheduled (ET)</dt>
                    <dd className="font-semibold tabular-nums mt-0.5">{formatUtcEt(selectedConsultation.startUtc)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Target Event</dt>
                    <dd className="font-medium tabular-nums mt-0.5">{selectedConsultation.eventDate}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Guests & Investment</dt>
                    <dd className="font-medium tabular-nums mt-0.5">
                      {selectedConsultation.guestCount} · {selectedConsultation.budgetRange}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--cs-charcoal-muted)]">Venue</dt>
                    <dd className="font-medium mt-0.5 truncate">{selectedConsultation.venueName}</dd>
                  </div>
                </dl>

                {/* Quick Lifecycle & Assignment Controls */}
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {['Pending', 'Rescheduled', 'Draft'].includes(selectedConsultation.status) && (
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `/api/consultations/${selectedConsultation.id}/confirm`,
                            'PATCH',
                            undefined,
                            `Confirmed consultation ${selectedConsultation.referenceCode}.`,
                          )
                        }
                        className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                      >
                        Confirm Appointment
                      </button>
                    )}
                    {['Pending', 'Confirmed', 'Rescheduled'].includes(selectedConsultation.status) && (
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `/api/consultations/${selectedConsultation.id}/cancel`,
                            'POST',
                            { reason: 'Cancelled from studio command center' },
                            `Cancelled ${selectedConsultation.referenceCode} and released slot.`,
                          )
                        }
                        className="min-h-[40px] px-3.5 py-2 text-xs font-medium border border-red-300 text-red-800 hover:bg-red-50 rounded-md cursor-pointer"
                      >
                        Cancel & Release Slot
                      </button>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                      Assigned Lead Planner
                    </label>
                    <select
                      value={selectedConsultation.assignedPlannerId}
                      onChange={(e) =>
                        runAction(
                          `/api/consultations/${selectedConsultation.id}/assign`,
                          'PATCH',
                          { plannerId: e.target.value },
                          `Reassigned planner for ${selectedConsultation.referenceCode}.`,
                        )
                      }
                      className="w-full min-h-[40px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      {data?.planners.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.role})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Complete Consultation & Record Outcome */}
                {['Pending', 'Confirmed', 'Rescheduled'].includes(selectedConsultation.status) && (
                  <form onSubmit={handleCompleteSubmit} className="border-t border-[var(--cs-border)] pt-4 space-y-3">
                    <p className="text-xs font-semibold text-[var(--cs-purple)]">
                      Record Consultation Outcome & Next Step
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={outcomeStatus}
                        onChange={(e) => setOutcomeStatus(e.target.value as 'Completed' | 'No-show')}
                        className="px-2.5 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                      >
                        <option value="Completed">Completed</option>
                        <option value="No-show">No-show</option>
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={followUpDays}
                        onChange={(e) => setFollowUpDays(Number(e.target.value))}
                        title="Follow-up due in days"
                        className="px-2.5 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                      />
                    </div>
                    <textarea
                      rows={2}
                      required
                      value={outcomeSummary}
                      onChange={(e) => setOutcomeSummary(e.target.value)}
                      placeholder="Summarize floral direction, budget confirmation, and venue walkthrough takeaways..."
                      className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                    />
                    <input
                      type="text"
                      value={followUpTitle}
                      onChange={(e) => setFollowUpTitle(e.target.value)}
                      placeholder="Auto-create follow-up task title"
                      className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                    />
                    <button
                      type="submit"
                      className="w-full min-h-[40px] px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer"
                    >
                      Save Outcome & Advance CRM
                    </button>
                  </form>
                )}

                {selectedConsultation.outcomeSummary && (
                  <div className="p-3 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md text-xs">
                    <p className="font-semibold text-[var(--cs-purple)]">Recorded Outcome</p>
                    <p className="text-[var(--cs-charcoal)] mt-1">{selectedConsultation.outcomeSummary}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--cs-charcoal-muted)]">Select a consultation to manage details.</p>
            )}
          </div>
        </div>
      )}

      {/* 2. CRM CONVERSION PIPELINE & FOLLOW-UP TASKS */}
      {section === 'crm' && data && (
        <div className="space-y-6">
          <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-4">
            <div>
              <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                Consultation-to-Client CRM Conversion Funnel
              </h3>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                Tracks every inquiry from initial discovery through proposal acceptance and confirmed event booking.
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
              {CRM_PIPELINE_STAGES.map((stage, idx) => {
                const count = data.consultations.filter((c) => c.crmStage === stage).length;
                return (
                  <div key={stage} className="p-3 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md">
                    <p className="text-[10px] font-semibold text-[var(--cs-gold-muted)] tabular-nums">0{idx + 1}</p>
                    <p className="text-[11px] font-medium text-[var(--cs-charcoal)] mt-0.5 leading-snug">{stage}</p>
                    <p className="font-display text-xl font-semibold text-[var(--cs-purple)] tabular-nums mt-2">
                      {count}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-3">
              <h4 className="font-display text-lg font-semibold text-[var(--cs-purple)] inline-flex items-center gap-2">
                <Users className="w-4 h-4" />
                Client Conversion Decisions
              </h4>
              <div className="divide-y divide-[var(--cs-border)]">
                {data.consultations.map((c) => (
                  <div key={c.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <p className="font-semibold text-[var(--cs-charcoal)]">
                        {c.clientName} — {c.eventTitle}
                      </p>
                      <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                        {c.referenceCode} · Consultation: {c.status} · CRM Stage: {c.crmStage}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `/api/consultations/${c.id}/decision`,
                            'POST',
                            { decision: 'Approved' },
                            `Converted ${c.referenceCode} to Event Booked.`,
                          )
                        }
                        className="px-2.5 py-1.5 text-[11px] font-medium text-white bg-[var(--cs-purple)] rounded cursor-pointer"
                      >
                        Mark Event Booked
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `/api/consultations/${c.id}/decision`,
                            'POST',
                            { decision: 'Revision Requested' },
                            `Logged proposal revision request for ${c.referenceCode}.`,
                          )
                        }
                        className="px-2.5 py-1.5 text-[11px] font-medium border border-[var(--cs-border-strong)] rounded cursor-pointer"
                      >
                        Revision
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-5 bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-4">
              <h4 className="font-display text-lg font-semibold text-[var(--cs-purple)] inline-flex items-center gap-2">
                <ClipboardList className="w-4 h-4" />
                Follow-Up Tasks
              </h4>
              <form onSubmit={handleCreateTask} className="space-y-2.5 pb-3 border-b border-[var(--cs-border)]">
                <input
                  type="text"
                  required
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="New CRM follow-up action..."
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                />
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={newTaskDueDate}
                    onChange={(e) => setNewTaskDueDate(e.target.value)}
                    className="flex-1 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer"
                  >
                    Add Task
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                {data.crmFollowUpTasks.map((t) => {
                  const isOverdue = t.status === 'Open' && new Date(t.dueAt).getTime() < Date.now();
                  return (
                    <div
                      key={t.id}
                      className={`p-3 rounded-md border text-xs flex items-start justify-between gap-3 ${
                        isOverdue ? 'border-amber-300 bg-amber-50/70' : 'border-[var(--cs-border)] bg-[var(--cs-ivory)]'
                      }`}
                    >
                      <div>
                        <p className={t.status === 'Completed' ? 'line-through text-[var(--cs-charcoal-muted)]' : 'font-semibold'}>
                          {t.title}
                        </p>
                        <p className="text-[11px] text-[var(--cs-charcoal-muted)] tabular-nums mt-0.5">
                          Due {t.dueAt.slice(0, 10)} · {t.assignedToName} · {isOverdue ? 'Overdue' : t.status}
                        </p>
                      </div>
                      {t.status === 'Open' && (
                        <button
                          type="button"
                          onClick={() =>
                            runAction(
                              `/api/crm/tasks/${t.id}`,
                              'PATCH',
                              { status: 'Completed' },
                              'Follow-up task marked completed.',
                            )
                          }
                          className="px-2.5 py-1 text-[11px] font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] rounded cursor-pointer shrink-0"
                        >
                          Done
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. PROPOSAL HANDOFF (INTEGER-CENT ITEMIZED QUOTATION BUILDER) */}
      {section === 'proposals' && data && (
        <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border)] pb-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                Consultation-to-Proposal Handoff
              </h3>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                Creates an exact cent-verified quotation version on the linked client booking and queues client notification.
              </p>
            </div>
            <select
              value={selectedConsultation?.id || ''}
              onChange={(e) => setSelectedId(e.target.value)}
              className="min-h-[40px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
            >
              {data.consultations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.referenceCode} — {c.clientName} ({c.status})
                </option>
              ))}
            </select>
          </div>

          <form onSubmit={handleProposalHandoff} className="space-y-4">
            <div className="space-y-2.5">
              {proposalItems.map((item, idx) => (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                  <input
                    type="text"
                    required
                    value={item.description}
                    onChange={(e) =>
                      setProposalItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, description: e.target.value } : p)),
                      )
                    }
                    className="sm:col-span-7 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                    placeholder="Line item description"
                  />
                  <input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) =>
                      setProposalItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, quantity: Math.max(1, Number(e.target.value)) } : p)),
                      )
                    }
                    className="sm:col-span-2 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(e) =>
                      setProposalItems((prev) =>
                        prev.map((p, i) => (i === idx ? { ...p, unitPrice: Math.max(0, Number(e.target.value)) } : p)),
                      )
                    }
                    className="sm:col-span-3 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setProposalItems((prev) => [...prev, { description: 'Additional Decor Element', quantity: 1, unitPrice: 1200 }])
                }
                className="text-xs font-medium text-[var(--cs-purple)] underline cursor-pointer"
              >
                + Add Line Item
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                  Courtesy Discount (USD)
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={proposalDiscount}
                  onChange={(e) => setProposalDiscount(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                  Proposal Terms & Design Notes
                </label>
                <input
                  type="text"
                  value={proposalNotes}
                  onChange={(e) => setProposalNotes(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md">
              <div className="text-xs space-y-0.5 tabular-nums">
                <p className="text-[var(--cs-charcoal-muted)]">
                  Subtotal: ${(proposalPreview.subtotalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} · Discount: ${(proposalPreview.discountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
                <p className="text-sm font-semibold text-[var(--cs-purple)]">
                  Exact Proposal Total: ${(proposalPreview.totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
              </div>
              <button
                type="submit"
                disabled={!selectedConsultation}
                className="min-h-[42px] px-5 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-50"
              >
                Issue Proposal & Notify Client
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 4. STAFF WEEKLY AVAILABILITY RULES */}
      {section === 'staff' && data && (
        <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border)] pb-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                Staff Consultation Schedules (America/New_York)
              </h3>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                Changes immediately govern real-time slot generation and booking validation.
              </p>
            </div>
            <select
              value={editingPlannerId}
              onChange={(e) => setEditingPlannerId(e.target.value)}
              className="min-h-[40px] px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
            >
              {data.planners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
          </div>

          <form onSubmit={handleSaveStaffSchedule} className="space-y-3">
            <div className="divide-y divide-[var(--cs-border)]">
              {editableRules.map((rule, idx) => (
                <div key={rule.dayOfWeek} className="py-2.5 grid grid-cols-2 sm:grid-cols-12 gap-2 items-center text-xs">
                  <label className="sm:col-span-2 flex items-center gap-2 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rule.isActive}
                      onChange={(e) =>
                        setEditableRules((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, isActive: e.target.checked } : r)),
                        )
                      }
                      className="accent-[var(--cs-purple)]"
                    />
                    {DAY_NAMES[rule.dayOfWeek]}
                  </label>
                  <input
                    type="time"
                    disabled={!rule.isActive}
                    value={rule.startTimeLocal}
                    onChange={(e) =>
                      setEditableRules((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, startTimeLocal: e.target.value } : r)),
                      )
                    }
                    className="sm:col-span-3 px-2 py-1.5 border border-[var(--cs-border-strong)] rounded tabular-nums disabled:opacity-45"
                  />
                  <input
                    type="time"
                    disabled={!rule.isActive}
                    value={rule.endTimeLocal}
                    onChange={(e) =>
                      setEditableRules((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, endTimeLocal: e.target.value } : r)),
                      )
                    }
                    className="sm:col-span-3 px-2 py-1.5 border border-[var(--cs-border-strong)] rounded tabular-nums disabled:opacity-45"
                  />
                  <span className="sm:col-span-4 text-[11px] text-[var(--cs-charcoal-muted)] tabular-nums">
                    {rule.isActive
                      ? `${rule.slotDurationMinutes}m slot · ${rule.bufferBeforeMinutes}m/${rule.bufferAfterMinutes}m buffer`
                      : 'Day off'}
                  </span>
                </div>
              ))}
            </div>
            <button
              type="submit"
              className="min-h-[42px] px-5 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
            >
              Save Weekly Schedule
            </button>
          </form>
        </div>
      )}

      {/* 5. NOTIFICATION OUTBOX MONITORING */}
      {section === 'notifications' && data && (
        <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border)] pb-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                Transactional Email Outbox (Resend)
              </h3>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                Tracks ProviderAccepted, Pending, Retrying, Skipped, and DeadLetter states without fabricating delivery.
              </p>
            </div>
            {currentRole === 'admin' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    runAction(
                      '/api/admin/consultations/reminders/dispatch',
                      'POST',
                      { horizonHours: 48 },
                      'Evaluated 48-hour consultation reminders and processed outbox.',
                    )
                  }
                  className="min-h-[38px] px-3.5 py-2 text-xs font-medium border border-[var(--cs-purple)] text-[var(--cs-purple)] rounded-md cursor-pointer"
                >
                  Dispatch 48h Reminders
                </button>
                <button
                  type="button"
                  onClick={() =>
                    runAction('/api/admin/outbox/process', 'POST', undefined, 'Processed pending notification outbox jobs.')
                  }
                  className="min-h-[38px] px-3.5 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer"
                >
                  Process Outbox Now
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--cs-border)] text-[var(--cs-charcoal-muted)]">
                  <th className="py-2 pr-3 font-medium">Ref</th>
                  <th className="py-2 pr-3 font-medium">Category</th>
                  <th className="py-2 pr-3 font-medium">Recipient</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Attempts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cs-border)]">
                {data.notificationOutbox.slice(0, 25).map((job) => (
                  <tr key={job.id}>
                    <td className="py-2.5 pr-3 font-semibold text-[var(--cs-purple)] tabular-nums">
                      {job.bookingReference || '—'}
                    </td>
                    <td className="py-2.5 pr-3">{job.category}</td>
                    <td className="py-2.5 pr-3 text-[var(--cs-charcoal-muted)]">{job.recipient}</td>
                    <td className="py-2.5 pr-3 font-medium">{job.status}</td>
                    <td className="py-2.5 pr-3 tabular-nums">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                  </tr>
                ))}
                {data.notificationOutbox.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-[var(--cs-charcoal-muted)]">
                      No outbox notification jobs queued yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6. CONSULTATION AUDIT HISTORY */}
      {section === 'audit' && data && (
        <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
          <div>
            <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
              Consultation & CRM Audit Trail
            </h3>
            <p className="text-xs text-[var(--cs-charcoal-muted)]">
              Immutable record of bookings, reschedules, cancellations, planner assignments, and proposals.
            </p>
          </div>
          <div className="divide-y divide-[var(--cs-border)] text-xs">
            {data.auditLogs.slice(0, 30).map((entry) => (
              <div key={entry.id} className="py-2.5 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-[var(--cs-purple)]">
                    {entry.action} · {entry.targetId}
                  </p>
                  <p className="text-[var(--cs-charcoal)]">{entry.details}</p>
                </div>
                <span className="text-[11px] text-[var(--cs-charcoal-muted)] tabular-nums shrink-0 inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {entry.actorName} ({entry.actorRole}) · {entry.timestamp.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            ))}
            {data.auditLogs.length === 0 && (
              <p className="py-6 text-center text-[var(--cs-charcoal-muted)] inline-flex items-center justify-center gap-2 w-full">
                <CheckCircle2 className="w-4 h-4 text-[var(--cs-purple)]" />
                No consultation audit events recorded yet.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
