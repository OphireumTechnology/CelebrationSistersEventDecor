import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AISessionRecord,
  AuditLogEntry,
  AuthSecurityEvent,
  AutomationLog,
  AutomationWorkflow,
  AvailabilityHold,
  BlackoutDate,
  BookingRecord,
  BookingStatus,
  DesignConceptRecord,
  InventoryItem,
  NotificationDeliveryRecord,
  StaffChecklistRecord,
  StaffVendorInvitation,
  UserRole,
  UserSession,
  VendorRecord,
} from '../src/types/domain.ts';
import { VALID_BOOKING_TRANSITIONS } from '../src/types/domain.ts';
import { LEGACY_TO_ARCH_STATUS } from '../src/types/lifecycle.ts';
import {
  assertPersistenceReady,
  getPersistenceAdapterMode,
  readDbFromPostgres,
  runPostgresTransaction,
} from './repositories/postgresRepository.ts';

export interface DatabaseSchema {
  users: UserSession[];
  bookings: BookingRecord[];
  availabilityHolds: AvailabilityHold[];
  blackoutDates: BlackoutDate[];
  concepts: DesignConceptRecord[];
  vendors: VendorRecord[];
  staffChecklists: StaffChecklistRecord[];
  inventory: InventoryItem[];
  aiSessions: AISessionRecord[];
  automationWorkflows: AutomationWorkflow[];
  automationLogs: AutomationLog[];
  auditLogs: AuditLogEntry[];
  invitations: StaffVendorInvitation[];
  authSecurityEvents: AuthSecurityEvent[];
  notificationDeliveries: NotificationDeliveryRecord[];
  bookingIdempotencyKeys: Record<string, string>;
}

function getDbPath(): string {
  if (process.env.CS_DB_PATH) {
    return path.resolve(process.env.CS_DB_PATH);
  }
  return path.resolve(process.cwd(), 'data', 'db.json');
}

function buildInitialSeed(): DatabaseSchema {
  return {
    users: [
      {
        id: 'user-client-camille',
        name: 'Camille Mercer',
        email: 'camille.mercer@example.com',
        role: 'client',
        organization: 'Mercer-Ellington Celebration',
      },
      {
        id: 'user-client-elena',
        name: 'Elena Vance',
        email: 'evance@palmettohealth-demo.org',
        role: 'client',
        organization: 'Palmetto Leadership Foundation',
      },
      {
        id: 'user-vendor-floral',
        name: 'Clara Sterling',
        email: 'clara@midlandsfloral.example.com',
        role: 'vendor',
        organization: 'Midlands Botanical Atelier',
      },
      {
        id: 'user-staff-maya',
        name: 'Maya Jenkins',
        email: 'maya@celebrationsisters.example.com',
        role: 'staff',
        organization: 'Celebration Sisters Production',
      },
      {
        id: 'user-admin-director',
        name: 'Victoria & Simone (Managing Sisters)',
        email: 'directors@celebrationsisters.example.com',
        role: 'admin',
        organization: 'Celebration Sisters Executive Office',
      },
    ],
    bookings: [
      {
        id: 'bkg-101',
        referenceCode: 'CS-2026-041',
        clientId: 'user-client-camille',
        clientName: 'Camille Mercer',
        clientEmail: 'camille.mercer@example.com',
        clientPhone: '(803) 555-0148',
        eventTitle: 'Mercer Autumn Estate Wedding & Reception',
        eventType: 'Wedding Planning and Design',
        serviceDivisionIds: ['wedding-planning', 'luxury-decor', 'event-lighting', 'photo-booths'],
        packageTier: 'Full Design & Production',
        eventDate: '2026-12-12',
        location: 'Columbia, SC',
        venueName: 'Lace House & Governor’s Gardens',
        guestCount: 210,
        budgetRange: '$28,000 – $36,000',
        status: 'Planning',
        notes: 'Royal purple velvet lounge accents, ivory garden roses, and brass hurricane lanterns along the historic staircase.',
        assignedLeadPlanner: 'Maya Jenkins',
        assignedVendorIds: ['vnd-floral', 'vnd-sound'],
        quotations: [
          {
            version: 1,
            createdAt: '2026-10-14T15:20:00.000Z',
            items: [
              { id: 'qi-1', description: 'Full-Service Wedding Design & Multi-Coordinator Direction', division: 'Wedding Planning and Design', quantity: 1, unitPrice: 8500 },
              { id: 'qi-2', description: 'Ceremony Floral Arch & 20 Tall Champagne Gold Centerpieces', division: 'Luxury Event Decoration and Styling', quantity: 1, unitPrice: 12400 },
              { id: 'qi-3', description: 'Wireless Amber & Royal Purple Ballroom Uplighting Suite', division: 'Event Lighting and Production', quantity: 1, unitPrice: 3200 },
              { id: 'qi-4', description: 'Studio Glam DSLR Portrait Booth (4 Hours + Custom Print)', division: 'Photo Booths and Guest Experiences', quantity: 1, unitPrice: 1650 },
            ],
            discountAmount: 750,
            discountReason: 'Multi-division luxury bundle courtesy credit',
            discountApprovedBy: 'Victoria (Managing Director)',
            discountApproved: true,
            totalAmount: 25000,
            notes: 'Includes Friday rehearsal direction and Sunday morning strike.',
          },
        ],
        contract: {
          id: 'ctr-101',
          bookingId: 'bkg-101',
          title: 'Master Event Production & Design Agreement — CS-2026-041',
          termsSummary: 'Full-service planning, floral installation, lighting production, and rental allocation for December 12, 2026 at Lace House Gardens.',
          clientSigned: true,
          clientSignedBy: 'Camille Mercer',
          clientSignedAt: '2026-10-18T11:05:00.000Z',
          staffCountersigned: true,
          staffCountersignedBy: 'Victoria (Managing Director)',
        },
        payments: [
          { id: 'pay-101-1', label: '50% Date Reservation Deposit', amount: 12500, dueDate: '2026-10-20', status: 'Paid', paidAt: '2026-10-19T14:12:00.000Z', reference: 'TXN-88412' },
          { id: 'pay-101-2', label: '25% Design & Floral Procurement', amount: 6250, dueDate: '2026-11-25', status: 'Pending' },
          { id: 'pay-101-3', label: '25% Final Production Balance', amount: 6250, dueDate: '2026-12-05', status: 'Pending' },
        ],
        milestones: [
          { id: 'ms-1', title: 'Approve Concept Studio floral & palette board', dueDate: '2026-11-18', owner: 'Client', completed: true },
          { id: 'ms-2', title: 'Confirm final guest count & seating chart', dueDate: '2026-11-28', owner: 'Client', completed: false },
          { id: 'ms-3', title: 'Venue lighting & rigging walkthrough', dueDate: '2026-12-02', owner: 'Production', completed: false },
        ],
        scheduleItems: [
          { time: '10:00 AM', activity: 'Production crew arrival, drapery & lighting rigging', lead: 'Maya Jenkins' },
          { time: '01:30 PM', activity: 'Floral arch & ballroom centerpiece installation', lead: 'Midlands Botanical Atelier' },
          { time: '04:30 PM', activity: 'Guest arrival & string prelude in courtyard', lead: 'Palmetto Sound & MC' },
          { time: '06:00 PM', activity: 'Ballroom reveal & seated dinner service', lead: 'Celebration Sisters Lead' },
        ],
        messages: [
          {
            id: 'msg-1',
            sender: 'Maya Jenkins',
            role: 'staff',
            text: 'Welcome to your Celebration Sisters portal, Camille. Your linen swatches and tall gold stands are reserved for December 12.',
            createdAt: '2026-11-10T10:30:00.000Z',
          },
        ],
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: '2026-11-10T10:30:00.000Z',
      },
      {
        id: 'bkg-102',
        referenceCode: 'CS-2026-054',
        clientId: 'user-client-elena',
        clientName: 'Elena Vance',
        clientEmail: 'evance@palmettohealth-demo.org',
        clientPhone: '(803) 555-0192',
        eventTitle: 'Palmetto Leadership Annual Awards Gala',
        eventType: 'Corporate Events',
        serviceDivisionIds: ['corporate-events', 'event-lighting', 'dj-entertainment'],
        packageTier: 'Executive Banquet & Awards',
        eventDate: '2027-01-23',
        location: 'Columbia, SC',
        venueName: 'Columbia Metropolitan Convention Center',
        guestCount: 350,
        budgetRange: '$35,000 – $48,000',
        status: 'Contract Pending',
        notes: 'Keynote stage backdrop, wireless podium audio, royal purple and gold table accents across 35 rounds.',
        assignedLeadPlanner: 'Maya Jenkins',
        assignedVendorIds: ['vnd-sound'],
        quotations: [
          {
            version: 1,
            createdAt: '2026-11-12T16:40:00.000Z',
            items: [
              { id: 'qi-201', description: 'Executive Gala Show-Calling & Production Direction', division: 'Corporate Events', quantity: 1, unitPrice: 9500 },
              { id: 'qi-202', description: '35 Banquet Tablescapes with Gold Plinth Florals', division: 'Luxury Event Decoration and Styling', quantity: 35, unitPrice: 380 },
              { id: 'qi-203', description: 'Stage Architectural Lighting & Dual Screen Uplight Wash', division: 'Event Lighting and Production', quantity: 1, unitPrice: 6800 },
              { id: 'qi-204', description: 'Keynote Audio Engineering & Gala MC Hosting', division: 'DJ, Entertainment and Hosting', quantity: 1, unitPrice: 3400 },
            ],
            discountAmount: 0,
            discountApproved: true,
            totalAmount: 33000,
            notes: 'Corporate W-9 and $2M Certificate of Insurance attached.',
          },
        ],
        contract: {
          id: 'ctr-102',
          bookingId: 'bkg-102',
          title: 'Corporate Gala Production Agreement — CS-2026-054',
          termsSummary: 'Full stage production, banquet decor for 350 guests, AV engineering, and corporate compliance package.',
          clientSigned: false,
          staffCountersigned: true,
          staffCountersignedBy: 'Simone (Managing Director)',
        },
        payments: [
          { id: 'pay-102-1', label: '50% Corporate Retainer Deposit', amount: 16500, dueDate: '2026-11-28', status: 'Pending' },
          { id: 'pay-102-2', label: '50% Net-15 Pre-Event Balance', amount: 16500, dueDate: '2027-01-08', status: 'Pending' },
        ],
        milestones: [
          { id: 'ms-201', title: 'Execute digital production contract', dueDate: '2026-11-22', owner: 'Client', completed: false },
          { id: 'ms-202', title: 'Submit corporate logo vector for stage projection', dueDate: '2026-12-10', owner: 'Client', completed: false },
        ],
        scheduleItems: [
          { time: '08:00 AM', activity: 'Convention hall truss & lighting load-in', lead: 'Production Crew' },
          { time: '05:30 PM', activity: 'VIP sponsor cocktail reception', lead: 'Maya Jenkins' },
          { time: '07:00 PM', activity: 'Awards banquet & keynote program', lead: 'Executive Producer' },
        ],
        messages: [
          {
            id: 'msg-201',
            sender: 'Victoria & Simone',
            role: 'admin',
            text: 'Your itemized corporate proposal is approved and your agreement is ready for digital signature.',
            createdAt: '2026-11-14T09:15:00.000Z',
          },
        ],
        createdAt: '2026-11-08T11:20:00.000Z',
        updatedAt: '2026-11-14T09:15:00.000Z',
      },
      {
        id: 'bkg-103',
        referenceCode: 'CS-2026-062',
        clientId: 'user-client-camille',
        clientName: 'Camille Mercer',
        clientEmail: 'camille.mercer@example.com',
        clientPhone: '(803) 555-0148',
        eventTitle: 'Mercer Pre-Wedding Champagne Welcome Soirée',
        eventType: 'Anniversaries and Private Events',
        serviceDivisionIds: ['luxury-decor', 'event-rentals'],
        packageTier: 'Heirloom Dinner Collection',
        eventDate: '2026-12-11',
        location: 'Lexington, SC',
        venueName: 'Lake Murray Private Conservatory',
        guestCount: 45,
        budgetRange: '$6,500 – $8,500',
        status: 'Quote Sent',
        notes: 'Intimate rehearsal eve cocktail and seated dinner overlooking Lake Murray.',
        assignedLeadPlanner: 'Maya Jenkins',
        assignedVendorIds: [],
        quotations: [
          {
            version: 1,
            createdAt: '2026-11-15T12:00:00.000Z',
            items: [
              { id: 'qi-301', description: 'Ivory Silk Tablescape, Gold Chargers & Taper Candles (45 guests)', division: 'Luxury Event Decoration and Styling', quantity: 1, unitPrice: 4800 },
              { id: 'qi-302', description: 'Plum Velvet Lounge Vignette & Delivery', division: 'Event Rentals and Logistics', quantity: 1, unitPrice: 2100 },
            ],
            discountAmount: 0,
            discountApproved: true,
            totalAmount: 6900,
            notes: 'Preliminary quotation valid for 14 days.',
          },
        ],
        contract: {
          id: 'ctr-103',
          bookingId: 'bkg-103',
          title: 'Welcome Soirée Styling Addendum — CS-2026-062',
          termsSummary: 'Boutique tablescape and lounge installation for December 11, 2026.',
          clientSigned: false,
          staffCountersigned: false,
        },
        payments: [
          { id: 'pay-103-1', label: '50% Retainer Deposit', amount: 3450, dueDate: '2026-11-30', status: 'Pending' },
        ],
        milestones: [
          { id: 'ms-301', title: 'Review quotation & confirm guest count', dueDate: '2026-11-24', owner: 'Client', completed: false },
        ],
        scheduleItems: [
          { time: '02:00 PM', activity: 'Lounge & tablescape installation', lead: 'Maya Jenkins' },
          { time: '06:30 PM', activity: 'Welcome toast & private dinner', lead: 'Host Family' },
        ],
        messages: [],
        createdAt: '2026-11-15T11:30:00.000Z',
        updatedAt: '2026-11-15T12:00:00.000Z',
      },
    ],
    concepts: [
      {
        id: 'cnc-101',
        bookingId: 'bkg-101',
        clientId: 'user-client-camille',
        title: 'Royal Heirloom Estate Ballroom Concept',
        eventType: 'Wedding Planning and Design',
        currentVersion: 1,
        revisions: [
          {
            version: 1,
            createdAt: '2026-11-05T14:00:00.000Z',
            themeName: 'Royal Heirloom Ballroom',
            visionSummary: 'Classic Southern estate architecture softened with overflowing ivory garden roses, warm champagne-gold tall stands, and deep royal purple silk accents.',
            colorPalette: [
              { name: 'Royal Purple', hex: '#4B2087', usage: 'Silk napkins, velvet lounge upholstery, menu crest' },
              { name: 'Champagne Gold', hex: '#B99045', usage: 'Tall floral stands, rimmed chargers, flatware, candle holders' },
              { name: 'Soft Ivory', hex: '#FAF8F4', usage: 'Floor-length drapery, linen cloths, garden roses' },
              { name: 'Warm Charcoal', hex: '#292929', usage: 'Calligraphy typography & architectural framing' },
            ],
            floralConcept: 'Asymmetric cloud-like compositions of white hydrangeas, Sahara ivory roses, and silver-dollar eucalyptus elevated on 36-inch brushed gold plinths.',
            tableArrangement: 'Alternating 72-inch ivory silk rounds and long estate banquet tables dressed with pleated purple silk runners and crystal stemware.',
            stageBackdrop: 'Custom ivory curved plaster wall with gold framing flanking the sweetheart table and subtle floral meadow ground clusters.',
            lightingPlan: 'Warm 2700K amber pin-spots focused on every floral tower paired with soft royal-purple architectural wall grazing after dinner.',
            recommendedDivisions: ['Wedding Planning and Design', 'Luxury Event Decoration and Styling', 'Event Lighting and Production'],
          },
        ],
        clientApproved: false,
        staffApproved: true,
        staffApprovedBy: 'Victoria (Lead Designer)',
        staffApprovedAt: '2026-11-06T09:00:00.000Z',
        isConceptualVisualization: true,
        createdAt: '2026-11-05T14:00:00.000Z',
      },
    ],
    vendors: [
      {
        id: 'vnd-floral',
        companyName: 'Midlands Botanical Atelier',
        contactName: 'Clara Sterling',
        email: 'clara@midlandsfloral.example.com',
        category: 'Floral Design & Botanicals',
        availabilityStatus: 'Booked',
        rating: 4.9,
        onboardingComplete: true,
        assignedBookingIds: ['bkg-101'],
        deliverables: [
          { id: 'del-1', bookingId: 'bkg-101', task: 'Deliver & hydrate 20 tall ivory rose towers', dueTime: '2026-12-12 01:30 PM', status: 'In Progress' },
          { id: 'del-2', bookingId: 'bkg-101', task: 'Install courtyard ceremony floral arch', dueTime: '2026-12-12 02:45 PM', status: 'Pending' },
        ],
      },
      {
        id: 'vnd-sound',
        companyName: 'Palmetto Sound & MC Collective',
        contactName: 'Devon Brooks',
        email: 'devon@palmettosound.example.com',
        category: 'DJ, Entertainment & AV',
        availabilityStatus: 'Available',
        rating: 4.8,
        onboardingComplete: true,
        assignedBookingIds: ['bkg-101', 'bkg-102'],
        deliverables: [
          { id: 'del-3', bookingId: 'bkg-101', task: 'Soundcheck wireless ceremony microphones', dueTime: '2026-12-12 03:30 PM', status: 'Pending' },
          { id: 'del-4', bookingId: 'bkg-102', task: 'Configure dual keynote podium mics & stage audio', dueTime: '2027-01-23 04:00 PM', status: 'Pending' },
        ],
      },
    ],
    staffChecklists: [
      {
        id: 'chk-101',
        bookingId: 'bkg-101',
        eventTitle: 'Mercer Autumn Estate Wedding & Reception',
        eventDate: '2026-12-12',
        staffMember: 'Maya Jenkins',
        roleTitle: 'Lead Production Coordinator',
        tasks: [
          { id: 't-1', label: 'Inspect 210 pressed ivory linens & royal purple napkins at warehouse', area: 'Logistics', completed: true },
          { id: 't-2', label: 'Verify DMX uplight battery charge & warm 2700K pin-spots', area: 'Lighting', completed: true },
          { id: 't-3', label: 'Confirm courtyard ceremony seating spacing & hurricane lanterns', area: 'Ceremony', completed: false },
          { id: 't-4', label: 'Test DSLR Portrait Booth printer & custom monogram frame', area: 'Guest Experience', completed: false },
        ],
        issuesReported: [],
      },
    ],
    inventory: [
      { id: 'inv-1', sku: 'CS-CHR-01', name: 'Champagne Gold Chiavari Chair (Cushion Included)', category: 'Seating', totalQuantity: 360, allocatedQuantity: 210, unitRentalPrice: 12, condition: 'Pristine' },
      { id: 'inv-2', sku: 'CS-LNG-04', name: 'Plum Velvet Curved VIP Lounge Set', category: 'Seating', totalQuantity: 6, allocatedQuantity: 2, unitRentalPrice: 650, condition: 'Pristine' },
      { id: 'inv-3', sku: 'CS-FLR-09', name: '36" Brushed Champagne Gold Floral Riser Stand', category: 'Floral Structures', totalQuantity: 40, allocatedQuantity: 20, unitRentalPrice: 45, condition: 'Pristine' },
      { id: 'inv-4', sku: 'CS-LGT-12', name: 'Wireless DMX Architectural LED Uplight (24-Pack)', category: 'Lighting & AV', totalQuantity: 8, allocatedQuantity: 3, unitRentalPrice: 480, condition: 'Pristine' },
      { id: 'inv-5', sku: 'CS-PTH-02', name: 'Studio Glam Open-Air DSLR Portrait Booth', category: 'Photo Booths', totalQuantity: 3, allocatedQuantity: 1, unitRentalPrice: 1650, condition: 'Pristine' },
      { id: 'inv-6', sku: 'CS-LIN-18', name: 'Ivory Satin 132" Round Floor-Length Linen', category: 'Linens', totalQuantity: 85, allocatedQuantity: 35, unitRentalPrice: 32, condition: 'Inspection Needed' },
    ],
    aiSessions: [
      {
        id: 'ais-001',
        createdAt: '2026-11-15T18:20:00.000Z',
        clientName: 'Lauren & Grant Whitaker',
        eventCategory: 'Baby Showers and Gender Reveals',
        eventDate: '2027-03-08',
        location: 'Irmo, SC',
        guestCount: 55,
        budgetRange: '$4,500 – $6,500',
        theme: 'Botanical Ivory & Champagne Gold Garden Tea',
        summary: 'Prospective client exploring garden-style baby shower styling for 55 guests in Irmo. Recommended Luxury Decor + Portrait Booth and captured lead for planner follow-up.',
        escalatedToHuman: false,
        messages: [
          { role: 'user', content: 'We are planning an elegant spring baby shower for about 55 guests in Irmo, SC.', timestamp: '2026-11-15T18:20:00.000Z' },
          { role: 'assistant', content: 'Congratulations! Our Baby Showers and Gender Reveals division specializes in refined botanical tablescapes and custom backdrops. May I note your target date and whether you would like a portrait booth or full tablescape styling?', timestamp: '2026-11-15T18:20:05.000Z' },
        ],
      },
    ],
    automationWorkflows: [
      { id: 'aut-1', name: 'New Inquiry Acknowledgment', trigger: 'On Booking Status -> Inquiry', channel: 'Email', authorizedEnabled: false, dispatchCount: 0 },
      { id: 'aut-2', name: 'Consultation 24h Reminder', trigger: '24h Before Consultation Scheduled', channel: 'Email', authorizedEnabled: false, dispatchCount: 0 },
      { id: 'aut-3', name: 'Quotation Follow-Up Cadence', trigger: '72h After Quote Sent', channel: 'Email', authorizedEnabled: false, dispatchCount: 0 },
      { id: 'aut-4', name: 'Payment Milestone Reminder', trigger: '5 Days Before Payment Due Date', channel: 'Email', authorizedEnabled: false, dispatchCount: 0 },
      { id: 'aut-5', name: 'Vendor Call-Time Dispatch', trigger: '48h Before Event Date', channel: 'Internal Task', authorizedEnabled: true, lastRunAt: '2026-11-16T08:00:00.000Z', dispatchCount: 3 },
    ],
    automationLogs: [
      {
        id: 'alog-1',
        workflowId: 'aut-5',
        workflowName: 'Vendor Call-Time Dispatch',
        recipient: 'Midlands Botanical Atelier (Internal Ops)',
        bookingRef: 'CS-2026-041',
        status: 'Dispatched',
        timestamp: '2026-11-16T08:00:00.000Z',
      },
    ],
    auditLogs: [
      {
        id: 'aud-1',
        timestamp: '2026-11-16T09:10:00.000Z',
        actorName: 'Victoria (Managing Director)',
        actorRole: 'admin',
        action: 'QUOTATION_DISCOUNT_APPROVED',
        targetType: 'Booking',
        targetId: 'CS-2026-041',
        details: 'Approved $750 multi-division bundle courtesy credit.',
      },
      {
        id: 'aud-2',
        timestamp: '2026-11-16T09:12:00.000Z',
        actorName: 'System Security Policy',
        actorRole: 'admin',
        action: 'OUTBOUND_MESSAGING_GUARD',
        targetType: 'Automation',
        targetId: 'aut-1..4',
        details: 'Outbound client email/SMS workflows held in authorized-pause state awaiting owner live activation.',
      },
    ],
    availabilityHolds: [],
    blackoutDates: [
      {
        id: 'blk-1',
        date: '2026-12-25',
        reason: 'Holiday Studio Closure',
        createdBy: 'Victoria & Simone (Managing Sisters)',
        createdAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    invitations: [],
    authSecurityEvents: [],
    notificationDeliveries: [],
    bookingIdempotencyKeys: {},
  };
}

function normalizeSchema(parsed: DatabaseSchema): DatabaseSchema {
  parsed.availabilityHolds = parsed.availabilityHolds || [];
  parsed.blackoutDates = parsed.blackoutDates || [];
  parsed.invitations = parsed.invitations || [];
  parsed.authSecurityEvents = parsed.authSecurityEvents || [];
  parsed.notificationDeliveries = parsed.notificationDeliveries || [];
  parsed.bookingIdempotencyKeys = parsed.bookingIdempotencyKeys || {};
  for (const b of parsed.bookings || []) {
    if (!b.architecturalStage) {
      b.architecturalStage = LEGACY_TO_ARCH_STATUS[b.status] ?? 'INQUIRY';
    }
  }
  return parsed;
}

let writeLock: Promise<void> = Promise.resolve();

async function ensureDbFile(): Promise<string> {
  const dbPath = getDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    const seed = buildInitialSeed();
    await fs.writeFile(dbPath, JSON.stringify(seed, null, 2), 'utf8');
  }
  return dbPath;
}

export async function readDb(): Promise<DatabaseSchema> {
  assertPersistenceReady();
  if (getPersistenceAdapterMode() === 'postgres') {
    const raw = await readDbFromPostgres(buildInitialSeed);
    return normalizeSchema(raw);
  }

  const dbPath = await ensureDbFile();
  const raw = await fs.readFile(dbPath, 'utf8');
  const parsed = JSON.parse(raw) as DatabaseSchema;
  return normalizeSchema(parsed);
}

export async function withTransaction<T>(fn: (db: DatabaseSchema) => Promise<T> | T): Promise<T> {
  assertPersistenceReady();
  if (getPersistenceAdapterMode() === 'postgres') {
    return runPostgresTransaction(buildInitialSeed, normalizeSchema, fn);
  }

  let release!: () => void;
  const prevLock = writeLock;
  writeLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prevLock;
  try {
    const dbPath = await ensureDbFile();
    const raw = await fs.readFile(dbPath, 'utf8');
    const db = normalizeSchema(JSON.parse(raw) as DatabaseSchema);
    const result = await fn(db);
    const tmpPath = `${dbPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmpPath, dbPath);
    return result;
  } finally {
    release();
  }
}

export function sanitizeUserForClient(user: UserSession): Omit<UserSession, 'totpSecret'> {
  const { totpSecret: _omitted, ...safeUser } = user;
  return safeUser;
}

export function appendAudit(
  db: DatabaseSchema,
  actor: UserSession,
  action: string,
  targetType: string,
  targetId: string,
  details: string,
): void {
  db.auditLogs.unshift({
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    actorName: actor.name,
    actorRole: actor.role,
    action,
    targetType,
    targetId,
    details,
  });
  if (db.auditLogs.length > 200) {
    db.auditLogs = db.auditLogs.slice(0, 200);
  }
}

export function appendSecurityEvent(
  db: DatabaseSchema,
  event: Omit<AuthSecurityEvent, 'id' | 'occurredAt'>,
): void {
  db.authSecurityEvents.unshift({
    id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    occurredAt: new Date().toISOString(),
    ...event,
  });
  if (db.authSecurityEvents.length > 500) {
    db.authSecurityEvents = db.authSecurityEvents.slice(0, 500);
  }
}

export function canTransitionBookingStatus(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return true;
  return VALID_BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function sanitizeBookingForRole(booking: BookingRecord, session: UserSession): BookingRecord | Partial<BookingRecord> {
  if (session.role === 'admin' || session.role === 'staff' || session.role === 'event_planner') {
    return booking;
  }
  if (session.role === 'client') {
    return booking;
  }
  if (session.role === 'vendor') {
    // Vendors only see operational details needed for their assignment; financial/private client notes omitted
    return {
      id: booking.id,
      referenceCode: booking.referenceCode,
      eventTitle: booking.eventTitle,
      eventType: booking.eventType,
      eventDate: booking.eventDate,
      location: booking.location,
      venueName: booking.venueName,
      guestCount: booking.guestCount,
      status: booking.status,
      assignedLeadPlanner: booking.assignedLeadPlanner,
      scheduleItems: booking.scheduleItems,
      serviceDivisionIds: booking.serviceDivisionIds,
      clientName: booking.clientName,
      clientId: '',
      clientEmail: '',
      clientPhone: '',
      packageTier: booking.packageTier,
      budgetRange: 'Protected',
      notes: 'Refer to assigned vendor deliverables schedule.',
      assignedVendorIds: booking.assignedVendorIds,
      quotations: [],
      contract: {
        id: booking.contract.id,
        bookingId: booking.id,
        title: 'Vendor Assignment Scope',
        termsSummary: 'Protected under client confidentiality.',
        clientSigned: booking.contract.clientSigned,
        staffCountersigned: booking.contract.staffCountersigned,
      },
      payments: [],
      milestones: [],
      messages: [],
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    };
  }
  return {};
}

export function isAuthorizedForBooking(booking: BookingRecord, session: UserSession, vendors: VendorRecord[]): boolean {
  if (session.role === 'admin' || session.role === 'staff' || session.role === 'event_planner') return true;
  if (session.role === 'client') return booking.clientId === session.id;
  if (session.role === 'vendor') {
    const vendor = vendors.find((v) => v.email.toLowerCase() === session.email.toLowerCase() || v.contactName === session.name);
    if (!vendor) return false;
    return booking.assignedVendorIds.includes(vendor.id) || vendor.assignedBookingIds.includes(booking.id);
  }
  return false;
}

export function hasRole(session: UserSession, allowed: UserRole[]): boolean {
  return allowed.includes(session.role);
}
