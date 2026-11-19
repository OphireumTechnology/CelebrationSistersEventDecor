import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminConsultationCommandCenter } from '../src/components/AdminConsultationCommandCenter.tsx';
import { ConsultationModal } from '../src/components/ConsultationModal.tsx';

test('Phase 14 Frontend UI: ConsultationModal renders accessible 4-step consultation wizard with preserved Celebration Sisters branding', () => {
  const html = renderToStaticMarkup(
    React.createElement(ConsultationModal, {
      open: true,
      initialEventType: 'Luxury Wedding Planning & Design',
      initialLocation: 'Columbia, SC',
      initialGuestCount: 150,
      onClose: () => {},
    }),
  );

  // Dialog semantics & accessible close control
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Close modal"/);

  // 4-step wizard navigation landmarks
  assert.match(html, /aria-label="Consultation booking progress"/);
  assert.match(html, /Event Discovery/);
  assert.match(html, /Schedule/);
  assert.match(html, /Your Details/);
  assert.match(html, /Review &amp; Confirm/);

  // Event discovery form controls + explicit separation of target event date
  assert.match(html, /Target Event Date/);
  assert.match(html, /Estimated Guests/);
  assert.match(html, /Investment Range/);
  assert.match(html, /Service Divisions of Interest/);

  // Self-service Manage / Track toggle
  assert.match(html, /Manage \/ Track/);

  // Brand logo & mobile touch-target sizing preserved
  assert.match(html, /celebration-sisters-logo\.png/);
  assert.match(html, /min-h-\[44px\]/);
});

test('Phase 14 Frontend UI: ConsultationModal renders nothing when closed', () => {
  const html = renderToStaticMarkup(
    React.createElement(ConsultationModal, {
      open: false,
      onClose: () => {},
    }),
  );
  assert.equal(html, '');
});

test('Phase 14 Frontend UI: AdminConsultationCommandCenter renders all operational modules cleanly', () => {
  const html = renderToStaticMarkup(
    React.createElement(AdminConsultationCommandCenter, {
      currentRole: 'admin',
    }),
  );

  assert.match(html, /Schedule &amp; Calendar/);
  assert.match(html, /CRM Conversion Pipeline/);
  assert.match(html, /Proposal Handoff/);
  assert.match(html, /Staff Availability/);
  assert.match(html, /Email Outbox/);
  assert.match(html, /Audit History/);
  assert.match(html, /Consultation Calendar &amp; Queue/);
});
