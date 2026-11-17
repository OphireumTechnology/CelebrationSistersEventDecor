export type UserRole = 'guest' | 'client' | 'vendor' | 'staff' | 'admin';

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
  clientSigned: boolean;
  clientSignedBy?: string;
  clientSignedAt?: string;
  staffCountersigned: boolean;
  staffCountersignedBy?: string;
}

export interface PaymentMilestone {
  id: string;
  label: string;
  amount: number;
  dueDate: string;
  status: 'Pending' | 'Paid' | 'Overdue';
  paidAt?: string;
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
