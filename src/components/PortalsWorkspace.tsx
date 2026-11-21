import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  KeyRound,
  Lock,
  LogOut,
  Package,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  BOOKING_STATUSES,
  VALID_BOOKING_TRANSITIONS,
  type AISessionRecord,
  type AuditLogEntry,
  type AutomationLog,
  type AutomationWorkflow,
  type BlackoutDate,
  type BookingRecord,
  type BookingStatus,
  type DesignConceptRecord,
  type InventoryItem,
  type StaffChecklistRecord,
  type UserSession,
  type VendorRecord,
} from '../types/domain';
import { apiFetch, isBackendConfigured } from '../lib/apiClient';
import { toArchitecturalStage } from '../types/lifecycle';
import { AdminConsultationCommandCenter } from './AdminConsultationCommandCenter';
import { BrandLogo } from './BrandLogo';

interface PortalsWorkspaceProps {
  currentUser: UserSession;
  mfaRequired: boolean;
  mfaEnrolled?: boolean;
  externalStagingMode?: boolean;
  hasPendingExternalFactor?: boolean;
  authProviderReady?: boolean;
  personas: UserSession[];
  onSwitchPersona: (user: UserSession) => Promise<void>;
  onEmailLogin?: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  onPasswordReset?: (email: string) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onVerifyMfa: (code: string) => Promise<{ ok: boolean; error?: string }>;
  onEnrollTotp?: (optionsOrRecoveryCode?: string | { replaceUnverified?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    factorId?: string;
    qrCode?: string;
    secret?: string;
    otpauthUri?: string;
    recoveryCodes?: string[];
  }>;
  onRecoverMfa?: (
    recoveryCode: string,
  ) => Promise<{ ok: boolean; remainingRecoveryCodes?: number; error?: string }>;
  onLogout: () => Promise<void>;
}

interface AdminOverviewData {
  metrics: {
    activeBookings: number;
    totalPipelineValue: number;
    collectedRevenue: number;
    aiSessionsCount: number;
    pendingApprovals: number;
  };
  aiSessions: AISessionRecord[];
  automationWorkflows: AutomationWorkflow[];
  automationLogs: AutomationLog[];
  auditLogs: AuditLogEntry[];
  blackoutDates: BlackoutDate[];
  users: UserSession[];
}

export function PortalsWorkspace({
  currentUser,
  mfaRequired,
  mfaEnrolled = false,
  externalStagingMode = false,
  hasPendingExternalFactor = false,
  authProviderReady = false,
  personas,
  onSwitchPersona,
  onEmailLogin,
  onPasswordReset,
  onVerifyMfa,
  onEnrollTotp,
  onRecoverMfa,
  onLogout,
}: PortalsWorkspaceProps) {
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [selectedBookingId, setSelectedBookingId] = useState<string>('');
  const [concepts, setConcepts] = useState<DesignConceptRecord[]>([]);
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [checklists, setChecklists] = useState<StaffChecklistRecord[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [adminData, setAdminData] = useState<AdminOverviewData | null>(null);

  const [loading, setLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [loginMode, setLoginMode] = useState<'login' | 'reset'>('login');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [mfaCode, setMfaCode] = useState('');
  const [mfaMode, setMfaMode] = useState<'totp' | 'recovery' | 'enroll'>('totp');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [totpEnrollment, setTotpEnrollment] = useState<{
    factorId?: string;
    qrCode?: string;
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  } | null>(null);
  const [signatureInput, setSignatureInput] = useState(currentUser.name);
  const [portalMessage, setPortalMessage] = useState('');
  const [issueSummary, setIssueSummary] = useState('');
  const [issueSeverity, setIssueSeverity] = useState<'Low' | 'Medium' | 'High'>('Low');
  const [staffTab, setStaffTab] = useState<'consultations' | 'checklists'>('consultations');
  const [adminTab, setAdminTab] = useState<
    'consultations' | 'bookings' | 'inventory' | 'ai' | 'automation' | 'audit'
  >('consultations');

  const [quoteDesc, setQuoteDesc] = useState('Custom Floral & Production Enhancement');
  const [quotePrice, setQuotePrice] = useState(2500);
  const [quoteDiscount, setQuoteDiscount] = useState(0);

  const [blackoutDate, setBlackoutDate] = useState('2027-07-04');
  const [blackoutReason, setBlackoutReason] = useState('Independence Day Holiday Studio Closure');

  const loadWorkspaceData = useCallback(async () => {
    if (currentUser.role === 'guest' || (currentUser.role === 'admin' && mfaRequired)) {
      setBookings([]);
      setVendors([]);
      setChecklists([]);
      setInventory([]);
      setAdminData(null);
      return;
    }

    setLoading(true);
    try {
      const [bkgRes, cncRes] = await Promise.all([
        apiFetch('/api/bookings', { credentials: 'include' }),
        apiFetch('/api/concepts', { credentials: 'include' }),
      ]);
      if (bkgRes.status === 401 || bkgRes.status === 403) {
        const errBody = await bkgRes.json().catch(() => ({}));
        setActionMessage({
          type: 'err',
          text: errBody.error || 'Your session expired or lacks permission to load workspace records.',
        });
      } else if (bkgRes.ok) {
        const bkgJson = await bkgRes.json();
        const list: BookingRecord[] = bkgJson.bookings || [];
        setBookings(list);
        if (list.length > 0 && !list.some((b) => b.id === selectedBookingId)) {
          setSelectedBookingId(list[0].id);
        }
      }
      if (cncRes.ok) {
        const cncJson = await cncRes.json();
        setConcepts(cncJson.concepts || []);
      }

      if (['vendor', 'event_planner', 'staff', 'admin'].includes(currentUser.role)) {
        const vRes = await apiFetch('/api/vendors', { credentials: 'include' });
        if (vRes.ok) setVendors((await vRes.json()).vendors || []);
      }

      if (['event_planner', 'staff', 'admin'].includes(currentUser.role)) {
        const [chkRes, invRes] = await Promise.all([
          apiFetch('/api/staff/checklists', { credentials: 'include' }),
          apiFetch('/api/inventory', { credentials: 'include' }),
        ]);
        if (chkRes.ok) setChecklists((await chkRes.json()).checklists || []);
        if (invRes.ok) setInventory((await invRes.json()).inventory || []);
      }

      if (currentUser.role === 'admin' && !mfaRequired) {
        const admRes = await apiFetch('/api/admin/overview', { credentials: 'include' });
        if (admRes.ok) setAdminData(await admRes.json());
      } else {
        setAdminData(null);
      }
    } catch {
      setActionMessage({
        type: 'err',
        text: 'Unable to reach the Celebration Sisters API backend. Check your connection and try again.',
      });
    } finally {
      setLoading(false);
    }
  }, [currentUser.role, mfaRequired, selectedBookingId]);

  useEffect(() => {
    setSignatureInput(currentUser.name);
    loadWorkspaceData();
  }, [currentUser, mfaRequired, loadWorkspaceData]);

  const activeBooking = bookings.find((b) => b.id === selectedBookingId) || bookings[0];

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onEmailLogin || authSubmitting) return;
    setActionMessage(null);
    setAuthSubmitting(true);
    try {
      const result = await onEmailLogin(loginEmail.trim(), loginPassword);
      if (!result.ok) {
        setActionMessage({ type: 'err', text: result.error || 'Sign-in failed.' });
        return;
      }
      setLoginPassword('');
      setActionMessage({ type: 'ok', text: 'Authenticated portal session established.' });
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handlePasswordResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onPasswordReset || authSubmitting) return;
    setActionMessage(null);
    setAuthSubmitting(true);
    try {
      const result = await onPasswordReset(loginEmail.trim());
      if (!result.ok) {
        setActionMessage({ type: 'err', text: result.error || 'Unable to submit password reset.' });
        return;
      }
      setActionMessage({
        type: 'ok',
        text: result.message || 'If an account matches that email, recovery instructions have been sent.',
      });
      setLoginMode('login');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setActionMessage(null);
    const result = await onVerifyMfa(mfaCode);
    if (!result.ok) {
      setActionMessage({ type: 'err', text: result.error || 'MFA failed.' });
      return;
    }
    setMfaCode('');
    setTotpEnrollment(null);
    setActionMessage({ type: 'ok', text: 'Executive MFA verification succeeded.' });
    await loadWorkspaceData();
  };

  const handleEnrollTotpClick = async (replaceUnverified = false) => {
    if (!onEnrollTotp || authSubmitting) return;
    setActionMessage(null);
    setAuthSubmitting(true);
    try {
      const result = externalStagingMode
        ? await onEnrollTotp({ replaceUnverified })
        : await onEnrollTotp();
      if (!result.ok || !result.secret || !result.otpauthUri) {
        setActionMessage({ type: 'err', text: result.error || 'Unable to generate authenticator enrollment.' });
        return;
      }
      setTotpEnrollment({
        factorId: result.factorId,
        qrCode: result.qrCode,
        secret: result.secret,
        otpauthUri: result.otpauthUri,
        recoveryCodes: result.recoveryCodes || [],
      });
      setMfaMode('enroll');
      setActionMessage({
        type: 'ok',
        text: externalStagingMode
          ? 'Authenticator QR code generated. Scan it in your authenticator app, then enter the 6-digit verification code below to complete AAL2 elevation.'
          : 'TOTP secret generated. Save your single-use recovery codes, then verify with a 6-digit authenticator code.',
      });
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleRecoverMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onRecoverMfa || authSubmitting) return;
    setActionMessage(null);
    setAuthSubmitting(true);
    try {
      const result = await onRecoverMfa(recoveryCodeInput.trim());
      if (!result.ok) {
        setActionMessage({ type: 'err', text: result.error || 'Recovery code rejected.' });
        return;
      }
      setRecoveryCodeInput('');
      setMfaMode('totp');
      setActionMessage({
        type: 'ok',
        text: `Executive MFA recovered (${result.remainingRecoveryCodes ?? 0} recovery codes remaining).`,
      });
      await loadWorkspaceData();
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignContract = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeBooking) return;
    setActionMessage(null);
    const res = await apiFetch(`/api/bookings/${activeBooking.id}/contract/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ signatureName: signatureInput }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMessage({ type: 'err', text: data.error || 'Unable to record signature.' });
      return;
    }
    setActionMessage({ type: 'ok', text: `Digital signature recorded for ${activeBooking.referenceCode}.` });
    await loadWorkspaceData();
  };

  const handlePayMilestone = async (paymentId: string) => {
    if (!activeBooking) return;
    const res = await apiFetch(`/api/bookings/${activeBooking.id}/payments/${paymentId}/pay`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMessage({ type: 'err', text: data.error || 'Unable to record payment.' });
      return;
    }
    setActionMessage({ type: 'ok', text: 'Staging payment milestone recorded.' });
    await loadWorkspaceData();
  };

  const handleToggleMilestone = async (milestoneId: string) => {
    if (!activeBooking) return;
    const res = await apiFetch(`/api/bookings/${activeBooking.id}/milestones/${milestoneId}`, {
      method: 'PATCH',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to update milestone.' });
      return;
    }
    await loadWorkspaceData();
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeBooking || !portalMessage.trim()) return;
    const res = await apiFetch(`/api/bookings/${activeBooking.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: portalMessage }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to send message.' });
      return;
    }
    setPortalMessage('');
    await loadWorkspaceData();
  };

  const handleTransitionStatus = async (bookingId: string, status: BookingStatus) => {
    setActionMessage(null);
    const res = await apiFetch(`/api/bookings/${bookingId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMessage({ type: 'err', text: data.error || 'Status transition rejected.' });
      return;
    }
    setActionMessage({ type: 'ok', text: `Booking status transitioned to "${status}".` });
    await loadWorkspaceData();
  };

  const handleCreateQuote = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeBooking) return;
    const res = await apiFetch(`/api/bookings/${activeBooking.id}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        items: [
          {
            description: quoteDesc,
            division: activeBooking.eventType,
            quantity: 1,
            unitPrice: Number(quotePrice),
          },
        ],
        discountAmount: Number(quoteDiscount),
        discountReason: quoteDiscount > 0 ? 'Director courtesy adjustment' : undefined,
        notes: 'Issued from Executive Administration Console',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMessage({ type: 'err', text: data.error || 'Unable to publish quotation.' });
      return;
    }
    setActionMessage({ type: 'ok', text: `Issued updated quotation for ${activeBooking.referenceCode}.` });
    await loadWorkspaceData();
  };

  const handleAddBlackoutDate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await apiFetch('/api/admin/blackout-dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ date: blackoutDate, reason: blackoutReason }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMessage({ type: 'err', text: data.error || 'Unable to add blackout date.' });
      return;
    }
    setActionMessage({ type: 'ok', text: `Blackout date ${blackoutDate} added.` });
    await loadWorkspaceData();
  };

  const handleVendorDeliverable = async (vendorId: string, delivId: string, status: 'Pending' | 'In Progress' | 'Completed') => {
    const res = await apiFetch(`/api/vendors/${vendorId}/deliverables/${delivId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to update deliverable.' });
      return;
    }
    await loadWorkspaceData();
  };

  const handleToggleChecklistTask = async (chkId: string, taskId: string) => {
    const res = await apiFetch(`/api/staff/checklists/${chkId}/tasks/${taskId}`, {
      method: 'PATCH',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to update checklist task.' });
      return;
    }
    await loadWorkspaceData();
  };

  const handleReportIssue = async (e: FormEvent, chkId: string) => {
    e.preventDefault();
    if (!issueSummary.trim()) return;
    const res = await apiFetch(`/api/staff/checklists/${chkId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ summary: issueSummary, severity: issueSeverity }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to report issue.' });
      return;
    }
    setIssueSummary('');
    await loadWorkspaceData();
  };

  const handleToggleAutomation = async (wfId: string, nextVal: boolean) => {
    const res = await apiFetch(`/api/admin/automation/${wfId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ authorizedEnabled: nextVal }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to update workflow authorization.' });
      return;
    }
    await loadWorkspaceData();
  };

  const handleRunAutomation = async (wfId: string) => {
    const res = await apiFetch(`/api/admin/automation/${wfId}/run`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setActionMessage({ type: 'err', text: data.error || 'Unable to trigger workflow.' });
      return;
    }
    await loadWorkspaceData();
  };

  return (
    <div className="bg-[var(--cs-ivory)] min-h-[82vh] py-10 text-[var(--cs-charcoal)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Cryptographically Signed Session Bar */}
        <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandLogo heightClass="h-10" />
            <div>
              <p className="text-xs font-semibold text-[var(--cs-purple)]">
                Signed HttpOnly Session · Role: {currentUser.role.toUpperCase()}
              </p>
              <p className="text-xs text-[var(--cs-charcoal-muted)]">
                {currentUser.name} · {currentUser.organization || 'Public Visitor'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {personas.length > 0 ? (
              <>
                <span className="text-xs text-[var(--cs-charcoal-muted)] mr-1">Sign In As:</span>
                {personas.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSwitchPersona(p)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                      currentUser.id === p.id
                        ? 'bg-[var(--cs-purple)] text-white border-[var(--cs-purple)]'
                        : 'bg-white text-[var(--cs-charcoal)] border-[var(--cs-border-strong)] hover:border-[var(--cs-purple)]'
                    }`}
                  >
                    {p.role === 'client' ? `Client (${p.name.split(' ')[0]})` : p.role.toUpperCase()}
                  </button>
                ))}
              </>
            ) : (
              <span className="text-xs text-[var(--cs-charcoal-muted)]">
                Demonstration switching disabled · Authenticated portal login required
              </span>
            )}
            {currentUser.role !== 'guest' && (
              <button
                type="button"
                onClick={onLogout}
                className="px-3 py-1.5 text-xs font-medium text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] border border-[var(--cs-border)] rounded-md inline-flex items-center gap-1 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            )}
          </div>
        </div>

        {!isBackendConfigured && (
          <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
            <div>
              <p className="font-semibold">Backend Connection Required for Protected Portal Sessions</p>
              <p className="mt-0.5 leading-relaxed">
                Static GitHub Pages hosting cannot issue signed HttpOnly authentication cookies or access private records. Connect your HTTPS API backend via <code className="font-mono">VITE_API_BASE_URL</code> to enable client, vendor, staff, and executive portals.
              </p>
            </div>
          </div>
        )}

        {actionMessage && (
          <div
            className={`p-3.5 rounded-md border text-xs font-medium flex items-center gap-2 ${
              actionMessage.type === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            {actionMessage.type === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{actionMessage.text}</span>
          </div>
        )}

        {currentUser.role === 'guest' ? (
          <div className="bg-white border border-[var(--cs-border)] rounded-lg p-8 sm:p-10 max-w-lg mx-auto space-y-6">
            <div className="text-center space-y-2.5">
              <Lock className="w-10 h-10 text-[var(--cs-purple)] mx-auto" />
              <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                Protected Client & Operations Workspaces
              </h2>
              <p className="text-xs sm:text-sm text-[var(--cs-charcoal-muted)] leading-relaxed">
                {personas.length > 0
                  ? 'Sign in with your verified account below or select a staging workspace account above to issue a signed HttpOnly session cookie.'
                  : 'Sign in with your verified Celebration Sisters account credentials to access role-isolated client, planner, vendor, and executive portals.'}
              </p>
            </div>

            {loginMode === 'login' ? (
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div>
                  <label htmlFor="portal-login-email" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                    Email Address
                  </label>
                  <input
                    id="portal-login-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="name@celebrationsistersdecor.com"
                    className="w-full min-h-[42px] px-3.5 py-2 text-sm border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="portal-login-password" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                    Password
                  </label>
                  <input
                    id="portal-login-password"
                    type="password"
                    required
                    minLength={6}
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full min-h-[42px] px-3.5 py-2 text-sm border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authSubmitting || !isBackendConfigured}
                  className="w-full min-h-[44px] py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-50"
                >
                  {authSubmitting ? 'Signing In...' : 'Sign In to Portal'}
                </button>
                <div className="flex items-center justify-between text-xs pt-1">
                  <span className="text-[var(--cs-charcoal-muted)]">
                    {externalStagingMode
                      ? 'Supabase External Staging Auth active (AAL2 enforced)'
                      : authProviderReady
                        ? 'Supabase Auth active'
                        : 'Identity provider awaiting server configuration'}
                  </span>
                  {!externalStagingMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionMessage(null);
                        setLoginMode('reset');
                      }}
                      className="text-[var(--cs-purple)] hover:underline font-medium cursor-pointer"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <form onSubmit={handlePasswordResetSubmit} className="space-y-4">
                <div>
                  <label htmlFor="portal-reset-email" className="block text-xs font-medium text-[var(--cs-charcoal)] mb-1">
                    Account Email Address
                  </label>
                  <input
                    id="portal-reset-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="name@celebrationsistersdecor.com"
                    className="w-full min-h-[42px] px-3.5 py-2 text-sm border border-[var(--cs-border-strong)] rounded-md"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authSubmitting || !isBackendConfigured}
                  className="w-full min-h-[44px] py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-50"
                >
                  {authSubmitting ? 'Sending Recovery Link...' : 'Send Password Recovery Link'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActionMessage(null);
                    setLoginMode('login');
                  }}
                  className="w-full py-2 text-xs font-medium text-[var(--cs-purple)] hover:underline cursor-pointer"
                >
                  Return to Portal Sign-In
                </button>
              </form>
            )}
          </div>
        ) : currentUser.role === 'admin' && mfaRequired ? (
          /* Executive MFA Gate (TOTP Verification, First-Time Enrollment & Recovery Code) */
          <div className="bg-white border border-[var(--cs-border)] rounded-lg p-8 sm:p-10 max-w-md mx-auto space-y-5">
            <div className="text-center space-y-1.5">
              <KeyRound className="w-10 h-10 text-[var(--cs-purple)] mx-auto" />
              <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                Executive MFA Verification Required
              </h2>
              <p className="text-xs text-[var(--cs-charcoal-muted)] leading-relaxed">
                Privileged administrative endpoints require multi-factor verification. Enter your 6-digit authenticator code to unlock Executive Administration.
              </p>
            </div>

            {mfaMode === 'recovery' && !externalStagingMode ? (
              <form onSubmit={handleRecoverMfaSubmit} className="space-y-4">
                <input
                  type="text"
                  required
                  value={recoveryCodeInput}
                  onChange={(e) => setRecoveryCodeInput(e.target.value)}
                  placeholder="Enter single-use recovery code (e.g. A1B2C3-D4E5F6)"
                  className="w-full px-4 py-2.5 text-sm text-center font-mono border border-[var(--cs-border-strong)] rounded-md uppercase"
                />
                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer disabled:opacity-50"
                >
                  {authSubmitting ? 'Verifying Recovery Code...' : 'Verify Recovery Code & Unlock'}
                </button>
                <button
                  type="button"
                  onClick={() => setMfaMode('totp')}
                  className="w-full py-1.5 text-xs font-medium text-[var(--cs-purple)] hover:underline cursor-pointer"
                >
                  Back to 6-Digit Authenticator Code
                </button>
              </form>
            ) : (
              <form onSubmit={handleMfaSubmit} className="space-y-4">
                {externalStagingMode && hasPendingExternalFactor && !totpEnrollment && (
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 space-y-2 text-left">
                    <p className="font-semibold">Pending Authenticator Enrollment Detected</p>
                    <p className="leading-relaxed">
                      Your pending TOTP factor registration was preserved across reload (secret keys are never persisted in browser storage). Enter the 6-digit code from your authenticator app below, or start a fresh enrollment if you have not scanned the QR code yet.
                    </p>
                  </div>
                )}

                {totpEnrollment && (
                  <div className="p-4 bg-[var(--cs-ivory)] border border-[var(--cs-border-strong)] rounded-md space-y-2.5 text-left text-xs">
                    <p className="font-semibold text-[var(--cs-purple)]">Authenticator Setup (RFC 6238 TOTP)</p>
                    {totpEnrollment.qrCode && totpEnrollment.qrCode.startsWith('data:image/') && (
                      <div className="flex justify-center py-2 bg-white rounded border border-[var(--cs-border)]">
                        <img
                          src={totpEnrollment.qrCode}
                          alt="Scan this QR code in your authenticator app"
                          className="w-44 h-44 object-contain"
                        />
                      </div>
                    )}
                    <div>
                      <p className="text-[11px] text-[var(--cs-charcoal-muted)]">Manual Setup Secret:</p>
                      <p className="font-mono text-xs bg-white px-2.5 py-1.5 mt-1 rounded border border-[var(--cs-border)] break-all select-all">
                        {totpEnrollment.secret}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[var(--cs-charcoal-muted)]">Provisioning URI:</p>
                      <p className="font-mono text-[10px] bg-white px-2.5 py-1.5 mt-1 rounded border border-[var(--cs-border)] break-all select-all">
                        {totpEnrollment.otpauthUri}
                      </p>
                    </div>
                    {totpEnrollment.recoveryCodes.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-[var(--cs-charcoal)]">
                          Single-Use Recovery Codes (Save Once):
                        </p>
                        <div className="grid grid-cols-2 gap-1 mt-1 font-mono text-[11px]">
                          {totpEnrollment.recoveryCodes.map((rc) => (
                            <span key={rc} className="bg-white px-2 py-1 rounded border border-[var(--cs-border)] text-center">
                              {rc}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <input
                  type="password"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="Enter 6-digit MFA code"
                  className="w-full px-4 py-2.5 text-sm text-center tracking-widest border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                />
                <button
                  type="submit"
                  className="w-full py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                >
                  Verify & Unlock Executive Portal
                </button>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--cs-border)] text-xs">
                  {!mfaEnrolled && onEnrollTotp && (
                    <button
                      type="button"
                      disabled={authSubmitting}
                      onClick={() => handleEnrollTotpClick(externalStagingMode && hasPendingExternalFactor)}
                      className="text-[var(--cs-purple)] hover:underline font-medium cursor-pointer"
                    >
                      {externalStagingMode && hasPendingExternalFactor
                        ? 'Restart Authenticator Setup (TOTP)'
                        : 'Enroll Authenticator App (TOTP)'}
                    </button>
                  )}
                  {onRecoverMfa && !externalStagingMode && (
                    <button
                      type="button"
                      onClick={() => setMfaMode('recovery')}
                      className="text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)] underline cursor-pointer ml-auto"
                    >
                      Use Recovery Code
                    </button>
                  )}
                </div>
              </form>
            )}
          </div>
        ) : loading && bookings.length === 0 ? (
          <div className="bg-white border border-[var(--cs-border)] rounded-lg p-10 text-center text-sm text-[var(--cs-charcoal-muted)]">
            Loading authorized workspace records...
          </div>
        ) : currentUser.role === 'client' ? (
          /* PRIVATE CLIENT PORTAL */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <aside className="lg:col-span-4 space-y-4">
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-3">
                <h2 className="font-display text-lg font-semibold text-[var(--cs-purple)]">Your Celebrations</h2>
                <div className="space-y-2">
                  {bookings.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setSelectedBookingId(b.id)}
                      className={`w-full text-left p-3.5 rounded-md border transition-colors cursor-pointer ${
                        activeBooking?.id === b.id
                          ? 'bg-[var(--cs-purple-soft)] border-[var(--cs-purple)]'
                          : 'bg-white border-[var(--cs-border)] hover:border-[var(--cs-gold)]'
                      }`}
                    >
                      <p className="text-xs font-semibold text-[var(--cs-purple)] tabular-nums">
                        {b.referenceCode} · {b.status}
                      </p>
                      <p className="text-sm font-semibold text-[var(--cs-charcoal)] mt-0.5">{b.eventTitle}</p>
                      <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1 tabular-nums">
                        {b.eventDate} · {b.venueName}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {concepts.length > 0 && (
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5 space-y-3">
                  <h3 className="font-display text-base font-semibold text-[var(--cs-purple)]">
                    Design Concepts Pending Review
                  </h3>
                  {concepts.map((c) => (
                    <div key={c.id} className="border-t border-[var(--cs-border)] pt-3 text-xs space-y-1.5">
                      <p className="font-semibold">{c.title}</p>
                      <p className="text-[var(--cs-charcoal-muted)]">
                        Client: {c.clientApproved ? 'Approved' : 'Pending'} · Studio:{' '}
                        {c.staffApproved ? 'Approved' : 'Pending'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </aside>

            {activeBooking && (
              <div className="lg:col-span-8 space-y-6">
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--cs-border)] pb-4">
                    <div>
                      <p className="text-xs text-[var(--cs-gold-muted)] font-medium tabular-nums">
                        {activeBooking.referenceCode} · {activeBooking.eventDate} · {activeBooking.guestCount} Guests
                      </p>
                      <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                        {activeBooking.eventTitle}
                      </h2>
                      <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                        {activeBooking.venueName} ({activeBooking.location}) · Lead Planner: {activeBooking.assignedLeadPlanner}
                      </p>
                    </div>
                    <div className="text-right space-y-1">
                      <span className="inline-block px-3 py-1.5 text-xs font-semibold bg-[var(--cs-purple)] text-white rounded-md">
                        {activeBooking.status}
                      </span>
                      <p className="text-[11px] font-mono text-[var(--cs-charcoal-muted)]">
                        Stage: {toArchitecturalStage(activeBooking.status, activeBooking.architecturalStage as never)}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-[var(--cs-charcoal)]">Booking & Production Lifecycle</p>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {BOOKING_STATUSES.filter((s) => s !== 'Cancelled').map((st) => {
                        const isCurrent = activeBooking.status === st;
                        const currentIndex = BOOKING_STATUSES.indexOf(activeBooking.status);
                        const idx = BOOKING_STATUSES.indexOf(st);
                        const reached = idx <= currentIndex && activeBooking.status !== 'Cancelled';
                        return (
                          <span
                            key={st}
                            className={`px-2 py-1 rounded border ${
                              isCurrent
                                ? 'bg-[var(--cs-purple)] text-white border-[var(--cs-purple)] font-semibold'
                                : reached
                                  ? 'bg-[var(--cs-purple-soft)] text-[var(--cs-purple)] border-[var(--cs-purple)]/20'
                                  : 'bg-[var(--cs-ivory)] text-[var(--cs-charcoal-muted)] border-[var(--cs-border)]'
                            }`}
                          >
                            {st}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Itemized Quotation & Payment Milestones */}
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-5">
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                    Itemized Quotation & Payment Milestones
                  </h3>

                  {activeBooking.quotations.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[var(--cs-border)] text-[var(--cs-charcoal-muted)]">
                            <th className="py-2 pr-4 font-medium">Description</th>
                            <th className="py-2 pr-4 font-medium">Division</th>
                            <th className="py-2 pr-4 font-medium text-right">Qty</th>
                            <th className="py-2 font-medium text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--cs-border)]/70">
                          {activeBooking.quotations[activeBooking.quotations.length - 1].items.map((item) => (
                            <tr key={item.id}>
                              <td className="py-2.5 pr-4 font-medium">{item.description}</td>
                              <td className="py-2.5 pr-4 text-[var(--cs-charcoal-muted)]">{item.division}</td>
                              <td className="py-2.5 pr-4 text-right tabular-nums">{item.quantity}</td>
                              <td className="py-2.5 text-right font-medium tabular-nums">
                                ${(item.quantity * item.unitPrice).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-[var(--cs-border-strong)] font-semibold text-sm text-[var(--cs-purple)]">
                            <td colSpan={3} className="py-3">
                              Quotation v{activeBooking.quotations[activeBooking.quotations.length - 1].version} Total
                            </td>
                            <td className="py-3 text-right tabular-nums">
                              ${activeBooking.quotations[activeBooking.quotations.length - 1].totalAmount.toLocaleString()}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--cs-charcoal-muted)]">
                      Your itemized quotation is currently in preparation following discovery consultation.
                    </p>
                  )}

                  {activeBooking.payments.length > 0 && (
                    <div className="border-t border-[var(--cs-border)] pt-4 space-y-2.5">
                      <p className="text-xs font-semibold text-[var(--cs-charcoal)]">
                        Payment Schedule (Staging Verification Mode)
                      </p>
                      {activeBooking.payments.map((pm) => (
                        <div
                          key={pm.id}
                          className="flex flex-wrap items-center justify-between gap-3 p-3 bg-[var(--cs-ivory)] border border-[var(--cs-border)] rounded-md text-xs"
                        >
                          <div>
                            <p className="font-semibold">{pm.label}</p>
                            <p className="text-[var(--cs-charcoal-muted)] tabular-nums">
                              Due {pm.dueDate} {pm.reference ? `· Ref ${pm.reference}` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-semibold tabular-nums">${pm.amount.toLocaleString()}</span>
                            {pm.status === 'Paid' ? (
                              <span className="text-emerald-700 font-semibold">Paid</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handlePayMilestone(pm.id)}
                                className="px-3 py-1.5 bg-[var(--cs-purple)] text-white rounded hover:bg-[var(--cs-purple-hover)] cursor-pointer"
                              >
                                Record Payment
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Digital Contract & Milestones */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                    <div className="flex items-center gap-2 text-[var(--cs-purple)]">
                      <FileSignature className="w-4 h-4" />
                      <h3 className="font-display text-lg font-semibold">Production Agreement</h3>
                    </div>
                    <p className="text-xs font-semibold">{activeBooking.contract.title}</p>
                    <p className="text-xs text-[var(--cs-charcoal-muted)] leading-relaxed">
                      {activeBooking.contract.termsSummary}
                    </p>
                    {activeBooking.contract.documentHash && (
                      <p className="text-[11px] font-mono text-[var(--cs-charcoal-muted)] break-all">
                        SHA-256 Digest: {activeBooking.contract.documentHash.slice(0, 24)}...
                      </p>
                    )}
                    <div className="text-xs space-y-1 pt-1">
                      <p>
                        Client Signature:{' '}
                        <span className="font-semibold">
                          {activeBooking.contract.clientSigned
                            ? `Signed by ${activeBooking.contract.clientSignedBy}`
                            : 'Pending Client Signature'}
                        </span>
                      </p>
                      <p>
                        Director Countersign:{' '}
                        <span className="font-semibold">
                          {activeBooking.contract.staffCountersigned
                            ? `Signed by ${activeBooking.contract.staffCountersignedBy}`
                            : 'Pending Director'}
                        </span>
                      </p>
                    </div>
                    {!activeBooking.contract.clientSigned && (
                      <form onSubmit={handleSignContract} className="space-y-2 pt-2">
                        <input
                          type="text"
                          required
                          value={signatureInput}
                          onChange={(e) => setSignatureInput(e.target.value)}
                          placeholder="Type full legal name to sign"
                          className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                        />
                        <button
                          type="submit"
                          className="w-full py-2 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                        >
                          Execute Digital Signature
                        </button>
                      </form>
                    )}
                  </div>

                  <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                    <div className="flex items-center gap-2 text-[var(--cs-purple)]">
                      <ClipboardCheck className="w-4 h-4" />
                      <h3 className="font-display text-lg font-semibold">Planning Milestones</h3>
                    </div>
                    <div className="space-y-2.5">
                      {activeBooking.milestones.map((ms) => (
                        <label
                          key={ms.id}
                          className="flex items-start gap-2.5 text-xs cursor-pointer p-2 rounded hover:bg-[var(--cs-ivory)]"
                        >
                          <input
                            type="checkbox"
                            checked={ms.completed}
                            onChange={() => handleToggleMilestone(ms.id)}
                            className="mt-0.5 accent-[var(--cs-purple)]"
                          />
                          <div>
                            <p className={ms.completed ? 'line-through text-[var(--cs-charcoal-muted)]' : 'font-medium'}>
                              {ms.title}
                            </p>
                            <p className="text-[11px] text-[var(--cs-charcoal-muted)] tabular-nums">
                              Due {ms.dueDate} · Owner: {ms.owner}
                            </p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-3">
                    <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                      Event-Day Run of Show
                    </h3>
                    {activeBooking.scheduleItems.length > 0 ? (
                      <div className="divide-y divide-[var(--cs-border)] text-xs">
                        {activeBooking.scheduleItems.map((item, idx) => (
                          <div key={idx} className="py-2.5 flex justify-between gap-3">
                            <div>
                              <p className="font-semibold text-[var(--cs-purple)] tabular-nums">{item.time}</p>
                              <p className="text-[var(--cs-charcoal)]">{item.activity}</p>
                            </div>
                            <span className="text-[var(--cs-charcoal-muted)] shrink-0">{item.lead}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--cs-charcoal-muted)]">Run-of-show timeline will populate during Planning stage.</p>
                    )}
                  </div>

                  <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-3">
                    <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                      Planner Communications
                    </h3>
                    <div className="space-y-2 max-h-44 overflow-y-auto">
                      {activeBooking.messages.map((m) => (
                        <div key={m.id} className="p-2.5 bg-[var(--cs-ivory)] rounded text-xs space-y-1">
                          <p className="font-semibold text-[var(--cs-purple)]">{m.sender}</p>
                          <p className="text-[var(--cs-charcoal)]">{m.text}</p>
                        </div>
                      ))}
                    </div>
                    <form onSubmit={handleSendMessage} className="flex gap-2 pt-1">
                      <input
                        type="text"
                        value={portalMessage}
                        onChange={(e) => setPortalMessage(e.target.value)}
                        placeholder="Message your planner..."
                        className="flex-1 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                      />
                      <button
                        type="submit"
                        className="px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer"
                      >
                        Send
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : currentUser.role === 'vendor' ? (
          /* VENDOR OPERATIONS PORTAL */
          <div className="space-y-6">
            <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
              <div>
                <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                  Vendor Assignment Workspace
                </h2>
                <p className="text-xs text-[var(--cs-charcoal-muted)]">
                  Record-level isolation active: displaying only assigned events and deliverables (client financials redacted).
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {bookings.map((b) => (
                  <div key={b.id} className="border border-[var(--cs-border)] rounded-md p-4 space-y-2 bg-[var(--cs-ivory)]">
                    <p className="text-xs font-semibold text-[var(--cs-purple)] tabular-nums">
                      {b.referenceCode} · {b.eventDate}
                    </p>
                    <h3 className="font-display text-lg font-semibold">{b.eventTitle}</h3>
                    <p className="text-xs text-[var(--cs-charcoal-muted)]">
                      Venue: {b.venueName} ({b.location}) · Guests: {b.guestCount} · Budget Field: {b.budgetRange}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {vendors.map((v) => (
              <div key={v.id} className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--cs-border)] pb-3">
                  <div>
                    <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">{v.companyName}</h3>
                    <p className="text-xs text-[var(--cs-charcoal-muted)]">
                      {v.category} · Contact: {v.contactName} · Availability: {v.availabilityStatus}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-[var(--cs-gold-muted)]">
                    Onboarding: {v.onboardingComplete ? 'Verified' : 'Incomplete'}
                  </span>
                </div>

                <div className="space-y-2.5">
                  {v.deliverables.map((del) => (
                    <div
                      key={del.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-3 border border-[var(--cs-border)] rounded-md text-xs"
                    >
                      <div>
                        <p className="font-semibold">{del.task}</p>
                        <p className="text-[var(--cs-charcoal-muted)] tabular-nums">Call Time: {del.dueTime}</p>
                      </div>
                      <select
                        value={del.status}
                        onChange={(e) =>
                          handleVendorDeliverable(
                            v.id,
                            del.id,
                            e.target.value as 'Pending' | 'In Progress' | 'Completed',
                          )
                        }
                        className="px-3 py-1.5 border border-[var(--cs-border-strong)] rounded bg-white text-xs"
                      >
                        <option value="Pending">Pending</option>
                        <option value="In Progress">In Progress</option>
                        <option value="Completed">Completed</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : currentUser.role === 'staff' || currentUser.role === 'event_planner' ? (
          /* STAFF & EVENT PLANNER PRODUCTION PORTAL */
          <div className="space-y-6">
            <div className="flex flex-wrap gap-1.5 bg-white border border-[var(--cs-border)] p-1.5 rounded-lg">
              <button
                type="button"
                onClick={() => setStaffTab('consultations')}
                className={`px-3.5 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  staffTab === 'consultations'
                    ? 'bg-[var(--cs-purple)] text-white'
                    : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
                }`}
              >
                <CalendarClock className="w-3.5 h-3.5" />
                Consultation & CRM Command Center
              </button>
              <button
                type="button"
                onClick={() => setStaffTab('checklists')}
                className={`px-3.5 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  staffTab === 'checklists'
                    ? 'bg-[var(--cs-purple)] text-white'
                    : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
                }`}
              >
                <ClipboardCheck className="w-3.5 h-3.5" />
                Event-Day Setup Checklists
              </button>
            </div>

            {staffTab === 'consultations' ? (
              <AdminConsultationCommandCenter
                currentRole={currentUser.role}
                onWorkspaceRefresh={loadWorkspaceData}
              />
            ) : (
            <div className="space-y-6">
            {checklists.map((chk) => (
              <div key={chk.id} className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--cs-border)] pb-4">
                  <div>
                    <p className="text-xs text-[var(--cs-gold-muted)] font-medium tabular-nums">
                      Event Date: {chk.eventDate} · Assigned Lead: {chk.staffMember} ({chk.roleTitle})
                    </p>
                    <h2 className="font-display text-2xl font-semibold text-[var(--cs-purple)]">
                      {chk.eventTitle} — Setup Checklist
                    </h2>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {chk.tasks.map((t) => (
                    <label
                      key={t.id}
                      className="flex items-start gap-3 p-3 border border-[var(--cs-border)] rounded-md cursor-pointer hover:bg-[var(--cs-ivory)] text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={t.completed}
                        onChange={() => handleToggleChecklistTask(chk.id, t.id)}
                        className="mt-0.5 accent-[var(--cs-purple)]"
                      />
                      <div>
                        <p className={t.completed ? 'line-through text-[var(--cs-charcoal-muted)]' : 'font-medium'}>
                          {t.label}
                        </p>
                        <p className="text-[11px] text-[var(--cs-charcoal-muted)]">Zone: {t.area}</p>
                      </div>
                    </label>
                  ))}
                </div>

                <form onSubmit={(e) => handleReportIssue(e, chk.id)} className="border-t border-[var(--cs-border)] pt-4 space-y-3">
                  <p className="text-xs font-semibold text-[var(--cs-purple)]">Report Event-Day Operational Issue</p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      value={issueSummary}
                      onChange={(e) => setIssueSummary(e.target.value)}
                      placeholder="Describe linen stain, missing power drop, or vendor delay..."
                      className="flex-1 px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                    />
                    <select
                      value={issueSeverity}
                      onChange={(e) => setIssueSeverity(e.target.value as 'Low' | 'Medium' | 'High')}
                      className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md bg-white"
                    >
                      <option value="Low">Low Severity</option>
                      <option value="Medium">Medium Severity</option>
                      <option value="High">High Severity</option>
                    </select>
                    <button
                      type="submit"
                      className="px-4 py-2 text-xs font-medium text-white bg-[var(--cs-purple)] rounded-md cursor-pointer"
                    >
                      Log Issue
                    </button>
                  </div>
                  {chk.issuesReported.length > 0 && (
                    <div className="space-y-1.5 pt-2">
                      {chk.issuesReported.map((iss) => (
                        <div key={iss.id} className="text-xs p-2.5 bg-amber-50 border border-amber-200 rounded">
                          <span className="font-semibold">[{iss.severity}]</span> {iss.summary}
                        </div>
                      ))}
                    </div>
                  )}
                </form>
              </div>
            ))}
            </div>
            )}
          </div>
        ) : (
          /* EXECUTIVE ADMINISTRATION DASHBOARD */
          <div className="space-y-6">
            {adminData && (
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5">
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">Active Bookings</p>
                  <p className="font-display text-2xl font-semibold text-[var(--cs-purple)] tabular-nums mt-1">
                    {adminData.metrics.activeBookings}
                  </p>
                </div>
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5">
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">Quoted Pipeline</p>
                  <p className="font-display text-2xl font-semibold text-[var(--cs-purple)] tabular-nums mt-1">
                    ${adminData.metrics.totalPipelineValue.toLocaleString()}
                  </p>
                </div>
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5">
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">Collected Deposits</p>
                  <p className="font-display text-2xl font-semibold text-[var(--cs-purple)] tabular-nums mt-1">
                    ${adminData.metrics.collectedRevenue.toLocaleString()}
                  </p>
                </div>
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5">
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">AI Consultations</p>
                  <p className="font-display text-2xl font-semibold text-[var(--cs-purple)] tabular-nums mt-1">
                    {adminData.metrics.aiSessionsCount}
                  </p>
                </div>
                <div className="bg-white border border-[var(--cs-border)] rounded-lg p-5">
                  <p className="text-xs text-[var(--cs-charcoal-muted)]">Concept Approvals Due</p>
                  <p className="font-display text-2xl font-semibold text-[var(--cs-purple)] tabular-nums mt-1">
                    {adminData.metrics.pendingApprovals}
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5 bg-white border border-[var(--cs-border)] p-1.5 rounded-lg">
              {[
                { id: 'consultations', label: 'Consultation Command Center', icon: CalendarClock },
                { id: 'bookings', label: 'Booking & Quote Oversight', icon: Users },
                { id: 'inventory', label: 'Rental Inventory', icon: Package },
                { id: 'ai', label: 'AI Concierge Logs', icon: ClipboardCheck },
                { id: 'automation', label: 'Controlled Automation', icon: ShieldCheck },
                { id: 'audit', label: 'Security Audit Log', icon: Lock },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setAdminTab(tab.id as typeof adminTab)}
                  className={`px-3.5 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors cursor-pointer ${
                    adminTab === tab.id
                      ? 'bg-[var(--cs-purple)] text-white'
                      : 'text-[var(--cs-charcoal-muted)] hover:text-[var(--cs-purple)]'
                  }`}
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              ))}
            </div>

            {adminTab === 'consultations' && (
              <AdminConsultationCommandCenter
                currentRole={currentUser.role}
                onWorkspaceRefresh={loadWorkspaceData}
              />
            )}

            {adminTab === 'bookings' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-7 bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                    Booking Pipeline & State-Machine Guardrails
                  </h3>
                  <div className="space-y-3">
                    {bookings.map((b) => {
                      const nextOptions = VALID_BOOKING_TRANSITIONS[b.status] || [];
                      return (
                        <div
                          key={b.id}
                          onClick={() => setSelectedBookingId(b.id)}
                          className={`p-4 border rounded-md cursor-pointer space-y-2.5 ${
                            activeBooking?.id === b.id
                              ? 'border-[var(--cs-purple)] bg-[var(--cs-purple-soft)]/50'
                              : 'border-[var(--cs-border)]'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-xs font-semibold text-[var(--cs-purple)] tabular-nums">
                                {b.referenceCode} · {b.eventDate} · {b.clientName}
                              </p>
                              <p className="text-sm font-semibold">{b.eventTitle}</p>
                            </div>
                            <div className="text-right">
                              <span className="text-xs font-semibold px-2.5 py-1 bg-white border border-[var(--cs-border)] rounded">
                                {b.status}
                              </span>
                              <p className="text-[10px] font-mono text-[var(--cs-charcoal-muted)] mt-1">
                                {toArchitecturalStage(b.status, b.architecturalStage as never)}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="text-[var(--cs-charcoal-muted)]">
                              Contract: {b.contract.clientSigned ? 'Signed' : 'Unsigned'} · Deposit:{' '}
                              {b.payments.some((p) => p.status === 'Paid') ? 'Verified' : 'Unpaid'}
                            </span>
                            <div className="ml-auto flex flex-wrap gap-1.5">
                              {nextOptions.map((nxt) => (
                                <button
                                  key={nxt}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleTransitionStatus(b.id, nxt);
                                  }}
                                  className="px-2.5 py-1 bg-[var(--cs-purple)] text-white rounded hover:bg-[var(--cs-purple-hover)] cursor-pointer"
                                >
                                  Move to {nxt}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="lg:col-span-5 space-y-6">
                  {activeBooking && (
                    <form
                      onSubmit={handleCreateQuote}
                      className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4"
                    >
                      <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                        Issue Quotation Version ({activeBooking.referenceCode})
                      </h3>
                      <p className="text-xs text-[var(--cs-charcoal-muted)]">
                        Current quote versions: {activeBooking.quotations.length}
                      </p>
                      <div>
                        <label className="block text-xs font-medium mb-1">Line Item Description</label>
                        <input
                          type="text"
                          required
                          value={quoteDesc}
                          onChange={(e) => setQuoteDesc(e.target.value)}
                          className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium mb-1">Amount ($)</label>
                          <input
                            type="number"
                            min={0}
                            value={quotePrice}
                            onChange={(e) => setQuotePrice(Number(e.target.value))}
                            className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Director Discount ($)</label>
                          <input
                            type="number"
                            min={0}
                            value={quoteDiscount}
                            onChange={(e) => setQuoteDiscount(Number(e.target.value))}
                            className="w-full px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                          />
                        </div>
                      </div>
                      <button
                        type="submit"
                        className="w-full py-2.5 text-xs font-medium text-white bg-[var(--cs-purple)] hover:bg-[var(--cs-purple-hover)] rounded-md cursor-pointer"
                      >
                        Publish Itemized Quotation v{activeBooking.quotations.length + 1}
                      </button>
                    </form>
                  )}

                  {/* Studio Blackout Dates Manager */}
                  <form
                    onSubmit={handleAddBlackoutDate}
                    className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-3"
                  >
                    <h3 className="font-display text-lg font-semibold text-[var(--cs-purple)]">
                      Studio Blackout Dates
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        required
                        value={blackoutDate}
                        onChange={(e) => setBlackoutDate(e.target.value)}
                        className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md tabular-nums"
                      />
                      <input
                        type="text"
                        required
                        value={blackoutReason}
                        onChange={(e) => setBlackoutReason(e.target.value)}
                        placeholder="Closure reason"
                        className="px-3 py-2 text-xs border border-[var(--cs-border-strong)] rounded-md"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 text-xs font-medium text-[var(--cs-purple)] border border-[var(--cs-purple)] hover:bg-[var(--cs-purple-soft)] rounded-md cursor-pointer"
                    >
                      Add Studio Blackout Date
                    </button>
                    {adminData?.blackoutDates && adminData.blackoutDates.length > 0 && (
                      <div className="pt-2 space-y-1 text-xs text-[var(--cs-charcoal-muted)]">
                        {adminData.blackoutDates.map((bd) => (
                          <div key={bd.id} className="flex justify-between">
                            <span className="tabular-nums font-medium text-[var(--cs-charcoal)]">{bd.date}</span>
                            <span>{bd.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </form>
                </div>
              </div>
            )}

            {adminTab === 'inventory' && (
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 overflow-x-auto">
                <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)] mb-4">
                  Columbia Warehouse Rental Inventory
                </h3>
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--cs-border)] text-[var(--cs-charcoal-muted)]">
                      <th className="py-2 pr-4">SKU</th>
                      <th className="py-2 pr-4">Item</th>
                      <th className="py-2 pr-4">Category</th>
                      <th className="py-2 pr-4 text-right">Allocated / Total</th>
                      <th className="py-2 pr-4 text-right">Unit Rate</th>
                      <th className="py-2">Condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--cs-border)]">
                    {inventory.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3 pr-4 font-mono text-[11px]">{item.sku}</td>
                        <td className="py-3 pr-4 font-medium">{item.name}</td>
                        <td className="py-3 pr-4 text-[var(--cs-charcoal-muted)]">{item.category}</td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {item.allocatedQuantity} / {item.totalQuantity}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">${item.unitRentalPrice}</td>
                        <td className="py-3">{item.condition}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {adminTab === 'ai' && adminData && (
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                  AI Event Concierge Session Review
                </h3>
                <div className="space-y-3">
                  {adminData.aiSessions.map((s) => (
                    <div key={s.id} className="p-4 border border-[var(--cs-border)] rounded-md space-y-1.5 text-xs">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold text-[var(--cs-purple)]">
                          {s.clientName || 'Prospective Client'} · {s.eventCategory || 'General Inquiry'}
                        </span>
                        <span className="text-[var(--cs-charcoal-muted)] tabular-nums">
                          {s.eventDate || 'Unspecified Date'} · {s.guestCount ?? '?'} Guests ·{' '}
                          {s.escalatedToHuman ? 'Escalated to Human' : 'Concierge Discovery'}
                        </span>
                      </div>
                      <p className="text-[var(--cs-charcoal)]">{s.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTab === 'automation' && adminData && (
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-6">
                <div>
                  <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                    Controlled Automation & Outbound Messaging Governance
                  </h3>
                  <p className="text-xs text-[var(--cs-charcoal-muted)] mt-1">
                    Outbound client communications remain paused until explicitly authorized by an Executive Director.
                  </p>
                </div>
                <div className="space-y-3">
                  {adminData.automationWorkflows.map((wf) => (
                    <div
                      key={wf.id}
                      className="flex flex-wrap items-center justify-between gap-4 p-4 border border-[var(--cs-border)] rounded-md text-xs"
                    >
                      <div>
                        <p className="font-semibold text-[var(--cs-purple)]">{wf.name}</p>
                        <p className="text-[var(--cs-charcoal-muted)]">
                          Trigger: {wf.trigger} · Channel: {wf.channel} · Dispatches:{' '}
                          <span className="tabular-nums">{wf.dispatchCount}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleToggleAutomation(wf.id, !wf.authorizedEnabled)}
                          className={`px-3 py-1.5 rounded font-medium cursor-pointer ${
                            wf.authorizedEnabled
                              ? 'bg-emerald-700 text-white'
                              : 'bg-amber-100 text-amber-900 border border-amber-300'
                          }`}
                        >
                          {wf.authorizedEnabled ? 'Authorized & Active' : 'Paused (Requires Approval)'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRunAutomation(wf.id)}
                          className="px-3 py-1.5 border border-[var(--cs-purple)] text-[var(--cs-purple)] rounded hover:bg-[var(--cs-purple-soft)] cursor-pointer"
                        >
                          Test Trigger
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-[var(--cs-border)] pt-4">
                  <h4 className="text-xs font-semibold text-[var(--cs-purple)] mb-2">Recent Automation Execution Log</h4>
                  <div className="space-y-1.5 text-xs">
                    {adminData.automationLogs.slice(0, 8).map((log) => (
                      <div key={log.id} className="flex justify-between gap-4 py-1.5 border-b border-[var(--cs-border)]/60">
                        <span>
                          {log.workflowName} ({log.bookingRef})
                        </span>
                        <span className="font-medium">{log.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {adminTab === 'audit' && adminData && (
              <div className="bg-white border border-[var(--cs-border)] rounded-lg p-6 space-y-4">
                <h3 className="font-display text-xl font-semibold text-[var(--cs-purple)]">
                  Immutable Security & Governance Audit Log
                </h3>
                <div className="space-y-2 text-xs">
                  {adminData.auditLogs.map((entry) => (
                    <div key={entry.id} className="p-3 border border-[var(--cs-border)] rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <span className="font-semibold text-[var(--cs-purple)]">{entry.action}</span>{' '}
                        <span className="text-[var(--cs-charcoal-muted)]">· {entry.details}</span>
                      </div>
                      <span className="text-[11px] text-[var(--cs-charcoal-muted)] tabular-nums shrink-0">
                        {entry.actorName} ({entry.actorRole})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
