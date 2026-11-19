import crypto from 'node:crypto';
import type {
  BlackoutDate,
  ConsultationAppointment,
  ConsultationMethod,
  ConsultationSlotHold,
  ConsultationStatus,
  StaffAvailabilityRule,
  UserSession,
} from '../src/types/domain.ts';
import { VALID_CONSULTATION_TRANSITIONS } from '../src/types/domain.ts';
import { sha256Hex } from './auth.ts';

export const STUDIO_TIMEZONE = 'America/New_York';

/**
 * Single authoritative studio preparation cutoff for consultation bookings & holds (2 hours).
 * Shared identically by availability generation, hold creation, booking creation, and rescheduling.
 */
export const MIN_CONSULTATION_NOTICE_MINUTES = 120;

export function meetsConsultationNotice(
  startUtc: string | Date,
  nowMs: number = Date.now(),
  minNoticeMinutes: number = MIN_CONSULTATION_NOTICE_MINUTES,
): boolean {
  const startMs = typeof startUtc === 'string' ? new Date(startUtc).getTime() : startUtc.getTime();
  if (Number.isNaN(startMs)) return false;
  return startMs >= nowMs + minNoticeMinutes * 60_000;
}

export const SUPPORTED_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'UTC',
] as const;

export interface ComputedConsultationSlot {
  slotId: string;
  plannerId: string;
  plannerName: string;
  dateLocal: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  displayLabel: string;
  studioDisplayLabel: string;
  available: boolean;
  unavailableReason?: string;
  allowedMethods: ConsultationMethod[];
}

export interface ConsultationDayAvailability {
  date: string;
  studioTimezone: string;
  clientTimezone: string;
  isBlackout: boolean;
  blackoutReason?: string;
  isStudioOpen: boolean;
  availableCount: number;
  slots: ComputedConsultationSlot[];
}

export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function canTransitionConsultationStatus(
  from: ConsultationStatus,
  to: ConsultationStatus,
): boolean {
  if (from === to) return true;
  return VALID_CONSULTATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Computes the UTC offset in minutes for a specific wall-clock moment in an IANA timezone.
 * Positive values mean local time is ahead of UTC; negative values (e.g. -300 for EST) mean behind UTC.
 */
function getTimezoneOffsetMinutes(utcDate: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(utcDate);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = Number(p.value);
    }
  }
  const asUtcMs = Date.UTC(
    map.year,
    (map.month || 1) - 1,
    map.day || 1,
    map.hour || 0,
    map.minute || 0,
    map.second || 0,
  );
  return Math.round((asUtcMs - utcDate.getTime()) / 60_000);
}

/**
 * Converts a local calendar date (YYYY-MM-DD) + HH:MM time in `timeZone` into an exact UTC Date.
 */
export function localDateTimeToUtc(dateIso: string, hhmm: string, timeZone: string): Date {
  const [year, month, day] = dateIso.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const roughUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset1 = getTimezoneOffsetMinutes(roughUtc, timeZone);
  const refinedUtc = new Date(roughUtc.getTime() - offset1 * 60_000);
  const offset2 = getTimezoneOffsetMinutes(refinedUtc, timeZone);
  if (offset2 !== offset1) {
    return new Date(roughUtc.getTime() - offset2 * 60_000);
  }
  return refinedUtc;
}

export function formatUtcForTimezone(utcIso: string, timeZone: string): string {
  const dt = new Date(utcIso);
  if (Number.isNaN(dt.getTime())) return utcIso;
  const safeTz = isValidIanaTimezone(timeZone) ? timeZone : STUDIO_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(dt);
}

export function formatFullDateTimeForTimezone(utcIso: string, timeZone: string): string {
  const dt = new Date(utcIso);
  if (Number.isNaN(dt.getTime())) return utcIso;
  const safeTz = isValidIanaTimezone(timeZone) ? timeZone : STUDIO_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(dt);
}

export function getDayOfWeekForIsoDate(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Evaluates major US federal studio holidays (New Year's Day, Memorial Day,
 * Independence Day, Labor Day, Thanksgiving, Christmas Day) deterministically for any year.
 */
export function getStudioHolidayReason(dateIso: string): string | null {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d) return null;
  if (m === 1 && d === 1) return "New Year's Day — Studio Closed";
  if (m === 7 && d === 4) return 'Independence Day — Studio Closed';
  if (m === 12 && d === 25) return 'Christmas Day — Studio Closed';

  const dow = getDayOfWeekForIsoDate(dateIso);
  // Memorial Day: Last Monday of May (May 25-31)
  if (m === 5 && dow === 1 && d >= 25) return 'Memorial Day — Studio Closed';
  // Labor Day: First Monday of September (Sep 1-7)
  if (m === 9 && dow === 1 && d <= 7) return 'Labor Day — Studio Closed';
  // Thanksgiving Day: Fourth Thursday of November (Nov 22-28)
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return 'Thanksgiving Day — Studio Closed';
  return null;
}

function parseMinutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function formatMinutesOfDay(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isActiveConsultationStatus(status: ConsultationStatus): boolean {
  return status === 'Pending' || status === 'Confirmed' || status === 'Rescheduled';
}

export function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

/**
 * Checks whether a candidate appointment window conflicts with any existing active consultation
 * or non-expired slot hold for the target planner (accounting for preparation & transition buffers).
 */
export function findPlannerSlotConflict(params: {
  plannerId: string;
  startUtc: string;
  endUtc: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  consultations: ConsultationAppointment[];
  slotHolds: ConsultationSlotHold[];
  excludeConsultationId?: string;
  ignoreHolderHash?: string;
  nowMs?: number;
}): { conflict: boolean; reason?: string; conflictingId?: string } {
  const nowMs = params.nowMs ?? Date.now();
  const candCoreStart = new Date(params.startUtc).getTime();
  const candCoreEnd = new Date(params.endUtc).getTime();
  const candBufStart = candCoreStart - params.bufferBeforeMinutes * 60_000;
  const candBufEnd = candCoreEnd + params.bufferAfterMinutes * 60_000;

  for (const c of params.consultations) {
    if (params.excludeConsultationId && c.id === params.excludeConsultationId) continue;
    if (!isActiveConsultationStatus(c.status)) continue;
    if (c.assignedPlannerId !== params.plannerId) continue;

    const exCoreStart = new Date(c.startUtc).getTime();
    const exCoreEnd = new Date(c.endUtc).getTime();
    const exBufStart = exCoreStart - c.bufferBeforeMinutes * 60_000;
    const exBufEnd = exCoreEnd + c.bufferAfterMinutes * 60_000;

    if (
      rangesOverlap(candCoreStart, candCoreEnd, exBufStart, exBufEnd) ||
      rangesOverlap(exCoreStart, exCoreEnd, candBufStart, candBufEnd)
    ) {
      return {
        conflict: true,
        reason: 'This appointment window overlaps an existing scheduled consultation or transition buffer.',
        conflictingId: c.id,
      };
    }
  }

  for (const hold of params.slotHolds) {
    if (new Date(hold.expiresAt).getTime() <= nowMs) continue;
    if (hold.plannerId !== params.plannerId) continue;
    if (params.ignoreHolderHash && hold.holderFingerprintHash === params.ignoreHolderHash) continue;

    const holdStart = new Date(hold.slotStartUtc).getTime();
    const holdEnd = new Date(hold.slotEndUtc).getTime();
    if (rangesOverlap(new Date(params.startUtc).getTime(), new Date(params.endUtc).getTime(), holdStart, holdEnd)) {
      return {
        conflict: true,
        reason: 'This slot is temporarily held by another prospective client.',
        conflictingId: hold.id,
      };
    }
  }

  return { conflict: false };
}

/**
 * Generates server-authoritative consultation availability across a date range.
 */
export function computeConsultationAvailability(params: {
  startDate: string;
  days: number;
  clientTimezone: string;
  method?: ConsultationMethod;
  plannerId?: string;
  durationMinutes?: number;
  rules: StaffAvailabilityRule[];
  consultations: ConsultationAppointment[];
  slotHolds: ConsultationSlotHold[];
  blackoutDates: BlackoutDate[];
  users: UserSession[];
  excludeConsultationId?: string;
  nowMs?: number;
}): ConsultationDayAvailability[] {
  const safeClientTz = isValidIanaTimezone(params.clientTimezone)
    ? params.clientTimezone
    : STUDIO_TIMEZONE;
  const nowMs = params.nowMs ?? Date.now();
  const safeDays = Math.max(1, Math.min(params.days, 45));

  const plannerNames = new Map<string, string>();
  for (const u of params.users) {
    plannerNames.set(u.id, u.name);
  }

  const results: ConsultationDayAvailability[] = [];

  for (let offset = 0; offset < safeDays; offset += 1) {
    const dateIso = addDaysIso(params.startDate, offset);
    const blackout = params.blackoutDates.find((b) => b.date === dateIso);
    const holidayReason = blackout ? null : getStudioHolidayReason(dateIso);
    const dow = getDayOfWeekForIsoDate(dateIso);

    if (blackout || holidayReason) {
      results.push({
        date: dateIso,
        studioTimezone: STUDIO_TIMEZONE,
        clientTimezone: safeClientTz,
        isBlackout: true,
        blackoutReason: blackout ? blackout.reason : holidayReason || 'Studio Holiday Closure',
        isStudioOpen: false,
        availableCount: 0,
        slots: [],
      });
      continue;
    }

    const matchingRules = params.rules.filter(
      (r) =>
        r.isActive &&
        r.dayOfWeek === dow &&
        (!params.plannerId || r.plannerId === params.plannerId) &&
        (!params.method || r.allowedMethods.includes(params.method)),
    );

    if (matchingRules.length === 0) {
      results.push({
        date: dateIso,
        studioTimezone: STUDIO_TIMEZONE,
        clientTimezone: safeClientTz,
        isBlackout: false,
        isStudioOpen: false,
        availableCount: 0,
        slots: [],
      });
      continue;
    }

    const daySlots: ComputedConsultationSlot[] = [];

    for (const rule of matchingRules) {
      const duration = params.durationMinutes ?? rule.slotDurationMinutes;
      const stepMinutes = duration + rule.bufferAfterMinutes;
      const startMin = parseMinutesOfDay(rule.startTimeLocal);
      const endMin = parseMinutesOfDay(rule.endTimeLocal);

      for (let cursor = startMin; cursor + duration <= endMin; cursor += stepMinutes) {
        const startLocal = formatMinutesOfDay(cursor);
        const startDateUtc = localDateTimeToUtc(dateIso, startLocal, rule.timezone || STUDIO_TIMEZONE);
        const endDateUtc = new Date(startDateUtc.getTime() + duration * 60_000);
        const startUtc = startDateUtc.toISOString();
        const endUtc = endDateUtc.toISOString();

        let available = true;
        let unavailableReason: string | undefined;

        if (!meetsConsultationNotice(startDateUtc, nowMs)) {
          available = false;
          unavailableReason = 'Past 2-hour booking notice cutoff';
        } else {
          const conflictCheck = findPlannerSlotConflict({
            plannerId: rule.plannerId,
            startUtc,
            endUtc,
            bufferBeforeMinutes: rule.bufferBeforeMinutes,
            bufferAfterMinutes: rule.bufferAfterMinutes,
            consultations: params.consultations,
            slotHolds: params.slotHolds,
            excludeConsultationId: params.excludeConsultationId,
            nowMs,
          });
          if (conflictCheck.conflict) {
            available = false;
            unavailableReason = conflictCheck.reason;
          }
        }

        daySlots.push({
          slotId: `${rule.plannerId}|${startUtc}`,
          plannerId: rule.plannerId,
          plannerName: rule.plannerName || plannerNames.get(rule.plannerId) || 'Lead Planner',
          dateLocal: dateIso,
          startUtc,
          endUtc,
          durationMinutes: duration,
          bufferBeforeMinutes: rule.bufferBeforeMinutes,
          bufferAfterMinutes: rule.bufferAfterMinutes,
          displayLabel: formatUtcForTimezone(startUtc, safeClientTz),
          studioDisplayLabel: formatUtcForTimezone(startUtc, rule.timezone || STUDIO_TIMEZONE),
          available,
          unavailableReason,
          allowedMethods: rule.allowedMethods,
        });
      }
    }

    daySlots.sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.plannerName.localeCompare(b.plannerName));

    results.push({
      date: dateIso,
      studioTimezone: STUDIO_TIMEZONE,
      clientTimezone: safeClientTz,
      isBlackout: false,
      isStudioOpen: true,
      availableCount: daySlots.filter((s) => s.available).length,
      slots: daySlots,
    });
  }

  return results;
}

/**
 * Validates that a requested consultation start/end falls inside an active planner rule
 * and does not land on a blackout date, in the past, or overlap existing bookings/holds.
 */
export function validateRequestedConsultationSlot(params: {
  plannerId: string;
  startUtc: string;
  method: ConsultationMethod;
  rules: StaffAvailabilityRule[];
  consultations: ConsultationAppointment[];
  slotHolds: ConsultationSlotHold[];
  blackoutDates: BlackoutDate[];
  excludeConsultationId?: string;
  ignoreHolderHash?: string;
  nowMs?: number;
}): {
  valid: boolean;
  errorCode?: 'INVALID_TIME' | 'BLACKOUT' | 'OUTSIDE_HOURS' | 'SLOT_CONFLICT';
  error?: string;
  endUtc?: string;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  plannerName?: string;
} {
  const nowMs = params.nowMs ?? Date.now();
  const startDt = new Date(params.startUtc);
  if (Number.isNaN(startDt.getTime())) {
    return { valid: false, errorCode: 'INVALID_TIME', error: 'Consultation start time must be a valid UTC ISO timestamp.' };
  }
  if (!meetsConsultationNotice(startDt, nowMs)) {
    return {
      valid: false,
      errorCode: 'INVALID_TIME',
      error: `Consultation appointments must be scheduled at least ${MIN_CONSULTATION_NOTICE_MINUTES / 60} hours in advance.`,
    };
  }

  // Convert startDt into studio date (YYYY-MM-DD) & HH:MM
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startDt);

  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') partMap[p.type] = p.value;
  }
  const studioDateIso = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const studioMins = Number(partMap.hour) * 60 + Number(partMap.minute);

  const blackout = params.blackoutDates.find((b) => b.date === studioDateIso);
  const holidayReason = blackout ? null : getStudioHolidayReason(studioDateIso);
  if (blackout || holidayReason) {
    return {
      valid: false,
      errorCode: 'BLACKOUT',
      error: `Studio is closed on ${studioDateIso} (${blackout ? blackout.reason : holidayReason}). Please select another consultation date.`,
    };
  }

  const dow = getDayOfWeekForIsoDate(studioDateIso);
  const rule = params.rules.find(
    (r) => r.isActive && r.plannerId === params.plannerId && r.dayOfWeek === dow,
  );
  if (!rule) {
    return {
      valid: false,
      errorCode: 'OUTSIDE_HOURS',
      error: 'Selected planner does not have consultation hours on this day.',
    };
  }
  if (!rule.allowedMethods.includes(params.method)) {
    return {
      valid: false,
      errorCode: 'OUTSIDE_HOURS',
      error: `Consultation method "${params.method}" is not available for the selected schedule.`,
    };
  }

  const ruleStartMins = parseMinutesOfDay(rule.startTimeLocal);
  const ruleEndMins = parseMinutesOfDay(rule.endTimeLocal);
  const durationMinutes = rule.slotDurationMinutes;
  if (studioMins < ruleStartMins || studioMins + durationMinutes > ruleEndMins) {
    return {
      valid: false,
      errorCode: 'OUTSIDE_HOURS',
      error: `Selected time falls outside studio consultation hours (${rule.startTimeLocal}–${rule.endTimeLocal} ${rule.timezone}).`,
    };
  }

  const endUtc = new Date(startDt.getTime() + durationMinutes * 60_000).toISOString();
  const conflict = findPlannerSlotConflict({
    plannerId: rule.plannerId,
    startUtc: startDt.toISOString(),
    endUtc,
    bufferBeforeMinutes: rule.bufferBeforeMinutes,
    bufferAfterMinutes: rule.bufferAfterMinutes,
    consultations: params.consultations,
    slotHolds: params.slotHolds,
    excludeConsultationId: params.excludeConsultationId,
    ignoreHolderHash: params.ignoreHolderHash,
    nowMs,
  });

  if (conflict.conflict) {
    return {
      valid: false,
      errorCode: 'SLOT_CONFLICT',
      error: conflict.reason || 'This consultation slot was just reserved. Please select another available time.',
    };
  }

  return {
    valid: true,
    endUtc,
    durationMinutes,
    bufferBeforeMinutes: rule.bufferBeforeMinutes,
    bufferAfterMinutes: rule.bufferAfterMinutes,
    plannerName: rule.plannerName,
  };
}

/**
 * Generates an unguessable 256-bit scoped verification token for public status/reschedule/cancel
 * access, storing ONLY its SHA-256 hash on the consultation record.
 */
export function generateConsultationAccessToken(): { token: string; hash: string } {
  const token = `csa_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256Hex(token) };
}

export function verifyConsultationAccessToken(
  providedToken: string | undefined,
  storedHash: string | undefined,
): boolean {
  if (!providedToken || !storedHash) return false;
  const trimmed = providedToken.trim();
  if (!trimmed || trimmed.length > 256) return false;
  const candidateHash = sha256Hex(trimmed);
  const a = Buffer.from(candidateHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface ConsultationTokenCheckResult {
  valid: boolean;
  code?: 'INVALID_CONSULTATION_TOKEN' | 'TOKEN_REVOKED' | 'TOKEN_EXPIRED';
  error?: string;
}

/**
 * Verifies a consultation's scoped public access token against its stored SHA-256 hash
 * AND enforces explicit revocation and expiration boundaries.
 */
export function validateConsultationTokenAccess(
  consultation: Pick<ConsultationAppointment, 'accessTokenHash' | 'accessTokenExpiresAt' | 'accessTokenRevokedAt'>,
  providedToken: string | undefined,
  nowMs: number = Date.now(),
): ConsultationTokenCheckResult {
  if (!verifyConsultationAccessToken(providedToken, consultation.accessTokenHash)) {
    return {
      valid: false,
      code: 'INVALID_CONSULTATION_TOKEN',
      error: 'Consultation record not found or verification token is invalid.',
    };
  }
  if (consultation.accessTokenRevokedAt) {
    return {
      valid: false,
      code: 'TOKEN_REVOKED',
      error: 'This consultation verification token has been revoked. Please sign in or contact our studio.',
    };
  }
  if (consultation.accessTokenExpiresAt) {
    const expMs = new Date(consultation.accessTokenExpiresAt).getTime();
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      return {
        valid: false,
        code: 'TOKEN_EXPIRED',
        error: 'This consultation verification token has expired. Please sign in or contact our studio for assistance.',
      };
    }
  }
  return { valid: true };
}
