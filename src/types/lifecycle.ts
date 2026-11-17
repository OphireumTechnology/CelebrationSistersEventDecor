import type { BookingStatus } from './domain.ts';

export const ARCHITECTURAL_LIFECYCLE_STAGES = [
  'INQUIRY',
  'CONSULTATION_SCHEDULED',
  'CONSULTATION_DONE',
  'QUOTE_DRAFT',
  'QUOTE_PENDING_APPROVAL',
  'QUOTE_SENT',
  'QUOTE_ACCEPTED',
  'CONTRACT_SENT',
  'CONTRACT_SIGNED',
  'DEPOSIT_PAID',
  'BOOKED',
  'IN_PLANNING',
  'FINAL_DETAILS_LOCKED',
  'BALANCE_PAID',
  'EVENT_DAY',
  'WRAP_UP',
  'COMPLETED',
  'REVIEW_REQUESTED',
] as const;

export const ARCHITECTURAL_OUTCOMES = [
  'EXPIRED',
  'DECLINED',
  'CANCELLED',
  'POSTPONED',
] as const;

export type ArchitecturalStage =
  | (typeof ARCHITECTURAL_LIFECYCLE_STAGES)[number]
  | (typeof ARCHITECTURAL_OUTCOMES)[number];

/**
 * Bidirectional compatibility map reconciling the persisted 13-stage prototype statuses
 * with the canonical 18-stage + 4-outcome enterprise architectural lifecycle.
 * Existing persisted records remain non-breaking while exposing canonical codes.
 */
export const LEGACY_TO_ARCH_STATUS: Record<BookingStatus, ArchitecturalStage> = {
  'Inquiry': 'INQUIRY',
  'Consultation Requested': 'INQUIRY',
  'Consultation Scheduled': 'CONSULTATION_SCHEDULED',
  'Proposal in Preparation': 'QUOTE_DRAFT',
  'Quote Sent': 'QUOTE_SENT',
  'Awaiting Approval': 'QUOTE_PENDING_APPROVAL',
  'Contract Pending': 'CONTRACT_SENT',
  'Payment Pending': 'CONTRACT_SIGNED',
  'Confirmed': 'BOOKED',
  'Planning': 'IN_PLANNING',
  'In Progress': 'EVENT_DAY',
  'Completed': 'COMPLETED',
  'Cancelled': 'CANCELLED',
};

export const ARCH_TO_LEGACY_STATUS: Record<ArchitecturalStage, BookingStatus> = {
  INQUIRY: 'Inquiry',
  CONSULTATION_SCHEDULED: 'Consultation Scheduled',
  CONSULTATION_DONE: 'Proposal in Preparation',
  QUOTE_DRAFT: 'Proposal in Preparation',
  QUOTE_PENDING_APPROVAL: 'Awaiting Approval',
  QUOTE_SENT: 'Quote Sent',
  QUOTE_ACCEPTED: 'Contract Pending',
  CONTRACT_SENT: 'Contract Pending',
  CONTRACT_SIGNED: 'Payment Pending',
  DEPOSIT_PAID: 'Confirmed',
  BOOKED: 'Confirmed',
  IN_PLANNING: 'Planning',
  FINAL_DETAILS_LOCKED: 'Planning',
  BALANCE_PAID: 'Planning',
  EVENT_DAY: 'In Progress',
  WRAP_UP: 'In Progress',
  COMPLETED: 'Completed',
  REVIEW_REQUESTED: 'Completed',
  EXPIRED: 'Cancelled',
  DECLINED: 'Cancelled',
  CANCELLED: 'Cancelled',
  POSTPONED: 'Consultation Scheduled',
};

export function toArchitecturalStage(
  legacyStatus: BookingStatus,
  explicitArchStage?: ArchitecturalStage,
): ArchitecturalStage {
  return explicitArchStage ?? LEGACY_TO_ARCH_STATUS[legacyStatus] ?? 'INQUIRY';
}
