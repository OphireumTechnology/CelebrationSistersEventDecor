export type UserRole = 'guest' | 'client' | 'vendor' | 'event_planner' | 'staff' | 'admin';

export type AccountStatus = 'active' | 'pending_verification' | 'suspended' | 'deactivated';

export const BOOKING_STATUSES = [
  'Inquiry',
  'Consultation Requested',
  'Consultation Scheduled',
  'Proposal in Preparation',
  'Quote Sent',
  'Awaiting Approval',
  'Contract Pending',
  'Payment Pending',
  'Confirmed',
  'Planning',
  'In Progress',
  'Completed',
  'Cancelled',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const VALID_BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  'Inquiry': ['Consultation Requested', 'Consultation Scheduled', 'Cancelled'],
  'Consultation Requested': ['Consultation Scheduled', 'Proposal in Preparation', 'Cancelled'],
  'Consultation Scheduled': ['Proposal in Preparation', 'Cancelled'],
  'Proposal in Preparation': ['Quote Sent', 'Cancelled'],
  'Quote Sent': ['Awaiting Approval', 'Proposal in Preparation', 'Cancelled'],
  'Awaiting Approval': ['Contract Pending', 'Proposal in Preparation', 'Cancelled'],
  'Contract Pending': ['Payment Pending', 'Cancelled'],
  'Payment Pending': ['Confirmed', 'Cancelled'],
  'Confirmed': ['Planning', 'Cancelled'],
  'Planning': ['In Progress', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  'Completed': [],
  'Cancelled': [],
};

export interface UserSession {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organization?: string;
  supabaseUserId?: string;
  emailVerified?: boolean;
  accountStatus?: AccountStatus;
  mfaEnrolled?: boolean;
  /** Server-side TOTP secret (never returned to browser clients). */
  totpSecret?: string;
  /** Server-side SHA-256 hashes of single-use MFA recovery codes (never returned to browser clients). */
  mfaRecoveryCodeHashes?: string[];
}

export type NotificationCategory =
  | 'consultation_confirmation'
  | 'consultation_confirmed'
  | 'consultation_rescheduled'
  | 'consultation_cancelled'
  | 'consultation_reminder'
  | 'consultation_followup'
  | 'proposal_available'
  | 'staff_new_booking_alert'
  | 'staff_appointment_assigned'
  | 'staff_upcoming_consultation'
  | 'staff_reschedule_alert'
  | 'staff_cancellation_alert'
  | 'staff_followup_required'
  | 'staff_proposal_awaiting_action'
  | 'booking_status_update'
  | 'admin_security_alert';

export interface NotificationDeliveryRecord {
  id: string;
  idempotencyKey: string;
  category: NotificationCategory;
  channel: 'Email' | 'SMS' | 'Internal Task';
  provider: 'resend' | 'unconfigured';
  recipient: string;
  bookingReference?: string;
  subject: string;
  status:
    | 'Queued'
    | 'ProviderAccepted'
    | 'Delivered'
    | 'Failed'
    | 'Skipped (Unconfigured)'
    | 'Skipped (Unauthorized)';
  providerMessageId?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type OutboxJobStatus =
  | 'Pending'
  | 'Claimed'
  | 'Retrying'
  | 'ProviderAccepted'
  | 'Delivered'
  | 'DeadLetter'
  | 'Skipped (Unconfigured)'
  | 'Skipped (Unauthorized)';

export interface OutboxNotificationJob {
  id: string;
  idempotencyKey: string;
  category: NotificationCategory;
  channel: 'Email' | 'SMS' | 'Internal Task';
  recipient: string;
  bookingReference?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  status: OutboxJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  claimedBy?: string;
  claimedAt?: string;
  providerMessageId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StaffVendorInvitation {
  id: string;
  email: string;
  assignedRole: 'vendor' | 'event_planner' | 'staff' | 'admin';
  tokenHash: string;
  invitedByUserId: string;
  invitedByName: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
}

export interface AuthSecurityEvent {
  id: string;
  occurredAt: string;
  eventType:
    | 'LOGIN_SUCCESS'
    | 'LOGIN_FAILED'
    | 'REGISTER_INITIATED'
    | 'TOKEN_REJECTED'
    | 'CSRF_REJECTED'
    | 'SPOOF_ATTEMPT'
    | 'EMAIL_PRIVILEGE_BIND_BLOCKED'
    | 'SUSPENDED_ACCOUNT_BLOCKED'
    | 'UNVERIFIED_EMAIL_BLOCKED'
    | 'MFA_VERIFIED'
    | 'MFA_FAILED'
    | 'MFA_ENROLLED'
    | 'MFA_REVOKED'
    | 'MFA_RECOVERY_USED'
    | 'ACCOUNT_LINKED'
    | 'ACCOUNT_STATUS_CHANGED'
    | 'SESSION_REVOKED'
    | 'RATE_LIMIT_FAIL_CLOSED'
    | 'INVITATION_ISSUED'
    | 'INVITATION_ACCEPTED'
    | 'INVITATION_REVOKED'
    | 'LOGOUT';
  userId?: string;
  emailHash?: string;
  outcome: 'allowed' | 'denied';
  details: string;
}

export interface QuoteLineItem {
  id: string;
  description: string;
  division: string;
  quantity: number;
  unitPrice: number;
}

export interface QuotationVersion {
  version: number;
  createdAt: string;
  items: QuoteLineItem[];
  discountAmount: number;
  discountReason?: string;
  discountApprovedBy?: string;
  discountApproved: boolean;
  totalAmount: number;
  notes: string;
}

export interface ContractRecord {
  id: string;
  bookingId: string;
  title: string;
  termsSummary: string;
  documentHash?: string;
  clientSigned: boolean;
  clientSignedBy?: string;
  clientSignedAt?: string;
  clientSignatureIp?: string;
  staffCountersigned: boolean;
  staffCountersignedBy?: string;
}

export interface AvailabilityHold {
  id: string;
  eventDate: string;
  venueName: string;
  clientEmail: string;
  expiresAt: string;
  createdAt: string;
}

export interface BlackoutDate {
  id: string;
  date: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface PaymentMilestone {
  id: string;
  label: string;
  amount: number;
  dueDate: string;
  status: 'Pending' | 'Paid' | 'Overdue' | 'Refunded' | 'Cancelled';
  paidAt?: string;
  refundedAt?: string;
  refundReason?: string;
  reference?: string;
}

export interface PlanningMilestone {
  id: string;
  title: string;
  dueDate: string;
  owner: 'Client' | 'Planner' | 'Production';
  completed: boolean;
}

export interface BookingRecord {
  id: string;
  referenceCode: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  eventTitle: string;
  eventType: string;
  serviceDivisionIds: string[];
  packageTier: string;
  eventDate: string;
  location: string;
  venueName: string;
  guestCount: number;
  budgetRange: string;
  status: BookingStatus;
  architecturalStage?: string;
  notes: string;
  assignedLeadPlanner: string;
  assignedVendorIds: string[];
  quotations: QuotationVersion[];
  contract: ContractRecord;
  payments: PaymentMilestone[];
  milestones: PlanningMilestone[];
  scheduleItems: { time: string; activity: string; lead: string }[];
  messages: { id: string; sender: string; role: UserRole; text: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ConceptRevision {
  version: number;
  createdAt: string;
  themeName: string;
  visionSummary: string;
  colorPalette: { name: string; hex: string; usage: string }[];
  floralConcept: string;
  tableArrangement: string;
  stageBackdrop: string;
  lightingPlan: string;
  recommendedDivisions: string[];
}

export interface DesignConceptRecord {
  id: string;
  bookingId: string;
  clientId: string;
  title: string;
  eventType: string;
  currentVersion: number;
  revisions: ConceptRevision[];
  clientApproved: boolean;
  clientApprovedAt?: string;
  staffApproved: boolean;
  staffApprovedBy?: string;
  staffApprovedAt?: string;
  isConceptualVisualization: true;
  createdAt: string;
}

export interface VendorRecord {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  category: string;
  availabilityStatus: 'Available' | 'Booked' | 'On Hold';
  rating: number;
  onboardingComplete: boolean;
  assignedBookingIds: string[];
  deliverables: {
    id: string;
    bookingId: string;
    task: string;
    dueTime: string;
    status: 'Pending' | 'In Progress' | 'Completed';
  }[];
}

export interface StaffChecklistRecord {
  id: string;
  bookingId: string;
  eventTitle: string;
  eventDate: string;
  staffMember: string;
  roleTitle: string;
  tasks: { id: string; label: string; area: string; completed: boolean }[];
  issuesReported: { id: string; summary: string; severity: 'Low' | 'Medium' | 'High'; reportedAt: string }[];
}

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  category: 'Linens' | 'Seating' | 'Floral Structures' | 'Lighting & AV' | 'Photo Booths' | 'Tableware';
  totalQuantity: number;
  allocatedQuantity: number;
  unitRentalPrice: number;
  condition: 'Pristine' | 'Inspection Needed' | 'In Maintenance';
}

export interface AISessionRecord {
  id: string;
  ownerUserId?: string;
  createdAt: string;
  clientName?: string;
  eventCategory?: string;
  eventDate?: string;
  location?: string;
  guestCount?: number;
  budgetRange?: string;
  theme?: string;
  summary: string;
  escalatedToHuman: boolean;
  messages: { role: 'user' | 'assistant'; content: string; timestamp: string }[];
}

export interface AutomationWorkflow {
  id: string;
  name: string;
  trigger: string;
  channel: 'Email' | 'SMS' | 'Internal Task';
  authorizedEnabled: boolean;
  lastRunAt?: string;
  dispatchCount: number;
}

export interface AutomationLog {
  id: string;
  workflowId: string;
  workflowName: string;
  recipient: string;
  bookingRef: string;
  status: 'Dispatched' | 'Skipped (Unauthorized)' | 'Retrying';
  timestamp: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
}

export const CONSULTATION_STATUSES = [
  'Draft',
  'Pending',
  'Confirmed',
  'Rescheduled',
  'Completed',
  'Cancelled',
  'No-show',
] as const;

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export const VALID_CONSULTATION_TRANSITIONS: Record<ConsultationStatus, ConsultationStatus[]> = {
  Draft: ['Pending', 'Confirmed', 'Cancelled'],
  Pending: ['Confirmed', 'Rescheduled', 'Cancelled'],
  Confirmed: ['Rescheduled', 'Completed', 'Cancelled', 'No-show'],
  Rescheduled: ['Confirmed', 'Rescheduled', 'Completed', 'Cancelled', 'No-show'],
  Completed: [],
  Cancelled: [],
  'No-show': ['Rescheduled', 'Cancelled'],
};

export type ConsultationMethod = 'in_person_columbia' | 'video' | 'phone';

export type PreferredContactMethod = 'email' | 'phone' | 'sms';

export const CRM_PIPELINE_STAGES = [
  'New Inquiry',
  'Qualified Lead',
  'Consultation Scheduled',
  'Consultation Completed',
  'Proposal Prepared',
  'Proposal Sent',
  'Client Decision',
  'Event Booked',
] as const;

export type CrmPipelineStage = (typeof CRM_PIPELINE_STAGES)[number];

export interface StaffAvailabilityRule {
  id: string;
  plannerId: string;
  plannerName: string;
  dayOfWeek: number; // 0 = Sun ... 6 = Sat
  startTimeLocal: string; // HH:MM
  endTimeLocal: string; // HH:MM
  timezone: string;
  slotDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  allowedMethods: ConsultationMethod[];
  isActive: boolean;
}

export interface ConsultationSlotHold {
  id: string;
  plannerId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  holderFingerprintHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface ConsultationAppointment {
  id: string;
  referenceCode: string;
  bookingId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  preferredContactMethod: PreferredContactMethod;
  eventTitle: string;
  eventCategory: string;
  eventTheme?: string;
  eventDate: string;
  eventLocation: string;
  venueName: string;
  guestCount: number;
  budgetRange: string;
  serviceDivisionIds: string[];
  additionalPreferences?: string;
  consultationNotes: string;
  method: ConsultationMethod;
  status: ConsultationStatus;
  crmStage: CrmPipelineStage;
  assignedPlannerId: string;
  assignedPlannerName: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  clientTimezone: string;
  privacyConsentAccepted: boolean;
  privacyConsentAt: string;
  privacyConsentVersion: string;
  /** SHA-256 hash of scoped public verification token; raw token is never persisted. */
  accessTokenHash: string;
  idempotencyKey?: string;
  outcomeSummary?: string;
  clientDecision?: 'Pending' | 'Approved' | 'Declined' | 'Revision Requested';
  clientDecisionNotes?: string;
  followUpDueAt?: string;
  rescheduledFromStartUtc?: string;
  rescheduleCount: number;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  reminderSentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmFollowUpTask {
  id: string;
  consultationId: string;
  bookingId: string;
  bookingReference: string;
  clientName: string;
  assignedToUserId: string;
  assignedToName: string;
  title: string;
  notes: string;
  dueAt: string;
  status: 'Open' | 'Completed' | 'Cancelled';
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
