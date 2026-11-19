import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequestedConsultationSlot } from '../server/scheduling.ts';

test('Phase 15: booking validation rejects slots inside the two-hour availability cutoff', () => {
  const nowMs = Date.parse('2026-11-19T12:00:00.000Z');
  const result = validateRequestedConsultationSlot({
    plannerId: 'planner-1',
    startUtc: new Date(nowMs + 90 * 60_000).toISOString(),
    method: 'video',
    rules: [],
    consultations: [],
    slotHolds: [],
    blackoutDates: [],
    nowMs,
  });
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, 'INVALID_TIME');
  assert.match(result.error ?? '', /2 hours/);
});
