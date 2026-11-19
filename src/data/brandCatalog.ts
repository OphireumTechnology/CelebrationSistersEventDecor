export interface ServiceDivision {
  id: string;
  slug: string;
  number: string;
  title: string;
  shortTitle: string;
  category: 'Planning & Milestones' | 'Design & Production' | 'Entertainment & Logistics';
  tagline: string;
  description: string;
  heroImage: string;
  startingGuidance: string;
  inclusions: string[];
  enhancements: string[];
  packages: {
    name: string;
    audience: string;
    summary: string;
    highlights: string[];
  }[];
  faqs: { q: string; a: string }[];
  relatedIds: string[];
}

export interface PortfolioItem {
  id: string;
  title: string;
  category: 'Weddings' | 'Social & Milestones' | 'Corporate & Brand' | 'Lighting & Lounge';
  location: string;
  venue: string;
  guestCount: number;
  season: string;
  image: string;
  caption: string;
  servicesUsed: string[];
  isVerifiedPortfolioPhoto: true;
}

const BASE_URL = (import.meta.env?.BASE_URL as string | undefined) ?? '/';

export const OFFICIAL_LOGO_SRC = `${BASE_URL}assets/celebration-sisters-logo.png`;

export const HERO_BALLROOM_IMAGE = `${BASE_URL}src/assets/images/hero_luxury_ballroom_1794948632249.jpg`;
export const IMG_WEDDING_FLORAL = `${BASE_URL}src/assets/images/service_wedding_floral_1794948632464.jpg`;
export const IMG_MILESTONE_SOIREE = `${BASE_URL}src/assets/images/service_milestone_soiree_1794948632179.jpg`;
export const IMG_CORPORATE_GALA = `${BASE_URL}src/assets/images/service_corporate_gala_1794948633026.jpg`;
export const IMG_LOUNGE_LIGHTING = `${BASE_URL}src/assets/images/service_lounge_lighting_1794948633528.jpg`;

export const SERVICE_DIVISIONS: ServiceDivision[] = [
  {
    id: 'wedding-planning',
    slug: 'wedding-planning-and-design',
    number: '01',
    title: 'Wedding Planning and Design',
    shortTitle: 'Weddings',
    category: 'Planning & Milestones',
    tagline: 'Full-service architectural wedding planning, floral artistry, and seamless day-of orchestration.',
    description:
      'From historic Columbia estates to Lake Murray waterfront celebrations, our sister-led design studio guides couples from initial spatial vision through rehearsal, ceremony, and grand reception.',
    heroImage: IMG_WEDDING_FLORAL,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Dedicated Lead Planner & Design Director',
      'Comprehensive vendor sourcing, contract review, and timeline engineering',
      'Bespoke ceremony arch, aisle, and reception tablescape styling',
      'Full rehearsal direction and multi-coordinator wedding-day management',
    ],
    enhancements: [
      'Multi-day welcome dinner and farewell brunch styling',
      'Custom monogrammed dance floor & stationery suite curation',
      'VIP bridal suite hospitality & concierge',
    ],
    packages: [
      {
        name: 'Signature Month-Of Coordination',
        audience: 'For couples with booked venues seeking flawless execution',
        summary: 'Timeline engineering, vendor confirmation, rehearsal, and full wedding-day direction.',
        highlights: ['6-week planning takeover', 'Master production run-of-show', '2 on-site coordinators'],
      },
      {
        name: 'Full Design & Production',
        audience: 'For couples desiring an end-to-end bespoke aesthetic',
        summary: 'Concept Studio mood boards, floral & rental curation, full planning, and white-glove strike.',
        highlights: ['Unlimited planning consultations', 'Custom tablescape mockup', 'Full installation & strike crew'],
      },
    ],
    faqs: [
      {
        q: 'How far in advance should we reserve wedding planning in Columbia, SC?',
        a: 'For full-service design and planning, we recommend reaching out 9 to 14 months ahead of your target date, though select seasonal dates remain available for partial planning.',
      },
      {
        q: 'Do you coordinate with outside venues across South Carolina?',
        a: 'Yes. While headquartered in Columbia, SC, our production teams regularly direct weddings in Lexington, Charleston, Greenville, and Charlotte.',
      },
    ],
    relatedIds: ['luxury-decor', 'photography-videography', 'event-lighting'],
  },
  {
    id: 'baby-showers',
    slug: 'baby-showers-and-gender-reveals',
    number: '02',
    title: 'Baby Showers and Gender Reveals',
    shortTitle: 'Baby Showers',
    category: 'Planning & Milestones',
    tagline: 'Refined botanical installations, bespoke dessert backdrops, and joyful reveal moments.',
    description:
      'Thoughtfully composed showers and gender reveals crafted with soft linens, organic balloon-and-floral arches, custom welcome signage, and effortless guest hosting.',
    heroImage: IMG_MILESTONE_SOIREE,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Custom backdrop installation with acrylic or calligraphic signage',
      'Styled gift, favor, and dessert presentation tables',
      'Curated linen, charger, and floral centerpiece styling',
      'Complete delivery, installation, and post-event breakdown',
    ],
    enhancements: [
      'Interactive mocktail & tea tasting cart',
      '360 or DSLR portrait booth with custom baby-shower print frame',
      'Coordinated gender-reveal lighting or confetti cue production',
    ],
    packages: [
      {
        name: 'Intimate Tea & Garden Styling',
        audience: 'For gatherings up to 40 guests',
        summary: 'Curated tablescape, floral focal backdrop, and welcome easel.',
        highlights: ['3-hour styling setup', 'Custom floral & linen palette', 'Same-evening strike'],
      },
      {
        name: 'Grand Reveal Experience',
        audience: 'For milestone family celebrations up to 120 guests',
        summary: 'Full room transformation, lounge vignette, entertainment hosting, and photography.',
        highlights: ['Custom reveal staging', 'Hosted guest activities', 'Portrait station included'],
      },
    ],
    faqs: [
      {
        q: 'Can you style a baby shower inside a private home or country club?',
        a: 'Yes. We design custom floor plans tailored to private residences, botanical gardens, and private club dining rooms throughout the Midlands.',
      },
    ],
    relatedIds: ['luxury-decor', 'photo-booths', 'birthdays-milestones'],
  },
  {
    id: 'birthdays-milestones',
    slug: 'birthdays-and-milestone-celebrations',
    number: '03',
    title: 'Birthdays and Milestone Celebrations',
    shortTitle: 'Milestones',
    category: 'Planning & Milestones',
    tagline: 'Editorial 30th, 40th, 50th, sweet sixteen, and gala birthday celebrations with unmistakable polish.',
    description:
      'Whether hosting an intimate candlelit dinner for thirty or a black-tie fiftieth soirée, we orchestrate cohesive decor, entertainment, lighting, and hospitality.',
    heroImage: IMG_MILESTONE_SOIREE,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Concept design & personalized color/texture palette',
      'Statement head table or guest-of-honor lounge setting',
      'Centerpieces, candlelight, and custom place-setting details',
      'Timeline coordination across catering, DJ, and photography',
    ],
    enhancements: [
      'Champagne tower staging & custom bar facade',
      'Live saxophonist or DJ + MC hosting',
      'Architectural uplighting and monogram projection',
    ],
    packages: [
      {
        name: 'Private Dinner Soirée',
        audience: 'For seated milestone dinners of 20–50 guests',
        summary: 'Editorial floral runners, taper candles, linen upgrades, and menu styling.',
        highlights: ['Bespoke tablescape', 'Custom place cards', 'White-glove reset'],
      },
      {
        name: 'Black-Tie Milestone Gala',
        audience: 'For large ballroom celebrations of 75–250+ guests',
        summary: 'Full room production, VIP lounge, DJ entertainment, lighting, and photo booth.',
        highlights: ['Dedicated event producer', 'Custom stage & backdrop', 'Full AV & lighting'],
      },
    ],
    faqs: [
      {
        q: 'Do you handle both kids milestone parties and adult luxury soirées?',
        a: 'Our design studio focuses on elevated milestone celebrations across all ages, maintaining clean luxury standards without cartoon clutter.',
      },
    ],
    relatedIds: ['dj-entertainment', 'photo-booths', 'event-lighting'],
  },
  {
    id: 'anniversaries-private',
    slug: 'anniversaries-and-private-events',
    number: '04',
    title: 'Anniversaries and Private Events',
    shortTitle: 'Anniversaries',
    category: 'Planning & Milestones',
    tagline: 'Timeless vow renewals, silver and golden anniversaries, and private family dinners.',
    description:
      'Celebrate enduring milestones with heirloom-inspired floral design, intimate candlelight, live acoustic ambiance, and discreet private-estate coordination.',
    heroImage: HERO_BALLROOM_IMAGE,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Private venue or estate spatial layout and styling',
      'Champagne-gold and ivory floral compositions with taper candlelight',
      'Memory gallery or tribute display installation',
      'Full coordination of catering cues and speeches',
    ],
    enhancements: [
      'Vow renewal ceremony styling and aisle florals',
      'Documentary photography and highlight cinematography',
      'Curated wine-pairing dinner table service styling',
    ],
    packages: [
      {
        name: 'Heirloom Dinner Collection',
        audience: 'For intimate family & friend gatherings',
        summary: 'Refined table design, custom menus, and ambient lighting.',
        highlights: ['Tailored centerpiece florals', 'Specialty linen & chargers', 'Evening breakdown'],
      },
    ],
    faqs: [
      {
        q: 'Can you incorporate family heirlooms or archival portraits into the decor?',
        a: 'Always. We routinely design museum-style tribute tables and framed timeline galleries honoring decades of marriage.',
      },
    ],
    relatedIds: ['wedding-planning', 'photography-videography', 'luxury-decor'],
  },
  {
    id: 'corporate-events',
    slug: 'corporate-events',
    number: '05',
    title: 'Corporate Events',
    shortTitle: 'Corporate',
    category: 'Planning & Milestones',
    tagline: 'Executive galas, awards banquets, leadership summits, and holiday hospitality.',
    description:
      'Precision production for South Carolina enterprises, law firms, healthcare institutions, and universities—combining brand alignment with hospitality excellence.',
    heroImage: IMG_CORPORATE_GALA,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Executive run-of-show engineering and speaker cue coordination',
      'Stage design, podium styling, and branded backdrop walls',
      'Banquet tablescape styling and VIP reception lounges',
      'Unified vendor, AV, lighting, and logistics management',
    ],
    enhancements: [
      'Multi-camera keynote capture and awards photography',
      'Custom step-and-repeat VIP arrival experience',
      'Branded lounge furniture and charging hospitality stations',
    ],
    packages: [
      {
        name: 'Executive Banquet & Awards',
        audience: 'For 100–500 attendee annual galas',
        summary: 'Full ballroom staging, centerpiece production, AV lighting, and show-calling.',
        highlights: ['Dedicated technical director', 'Stage & lectern design', 'COA & vendor compliance'],
      },
    ],
    faqs: [
      {
        q: 'Are you able to provide corporate W-9s and certificates of insurance?',
        a: 'Yes. All corporate engagements include commercial liability documentation, itemized invoicing, and net-terms options subject to approval.',
      },
    ],
    relatedIds: ['promotional-brand-events', 'event-lighting', 'event-rentals'],
  },
  {
    id: 'promotional-brand-events',
    slug: 'promotional-and-brand-events',
    number: '06',
    title: 'Promotional and Brand Events',
    shortTitle: 'Brand Events',
    category: 'Design & Production',
    tagline: 'High-impact product launches, press previews, and experiential brand activations.',
    description:
      'Translate brand guidelines into physical architectural environments that command attention, encourage organic photography, and deliver measurable guest engagement.',
    heroImage: IMG_CORPORATE_GALA,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Brand-color matched floral, drapery, and architectural plinths',
      'Custom press wall, step-and-repeat, and product display pedestals',
      'Press check-in desk and VIP hospitality lounge',
      'Rapid load-in and load-out precision crew',
    ],
    enhancements: [
      'Instant-share editorial photo booth with branded overlays',
      'Custom architectural lighting gobos and color washes',
      'Live event DJ and host pacing',
    ],
    packages: [
      {
        name: 'Product Launch & Activation',
        audience: 'For retail openings, luxury launches, and press receptions',
        summary: 'Custom hero installation, display plinths, lighting wash, and photography.',
        highlights: ['Brand palette matching', 'Custom vinyl/acrylic signage', 'Social-ready focal vignette'],
      },
    ],
    faqs: [
      {
        q: 'Can you match exact corporate Pantone or hex brand guidelines?',
        a: 'Yes. Through specialty linens, dyed florals, custom acrylics, and programmable LED wash lighting, we calibrate closely to your brand standards.',
      },
    ],
    relatedIds: ['corporate-events', 'photo-booths', 'event-lighting'],
  },
  {
    id: 'luxury-decor',
    slug: 'luxury-event-decoration-and-styling',
    number: '07',
    title: 'Luxury Event Decoration and Styling',
    shortTitle: 'Decor & Styling',
    category: 'Design & Production',
    tagline: 'Bespoke floral architecture, drapery, custom backdrops, and editorial tablescapes.',
    description:
      'Our signature craft: sculpting spaces with lush floral installations, silk and velvet textiles, fine gold hardware, and layered candlelight.',
    heroImage: HERO_BALLROOM_IMAGE,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Custom spatial mood boards and tablescape design previews',
      'Elevated floral arrangements, runners, and statement arches',
      'Architectural pipe-and-drape and custom backdrop walls',
      'Fine chargers, flatware, napkin treatments, and candle styling',
    ],
    enhancements: [
      'Ceiling floral chandeliers and suspended installations',
      'Custom sweetheart or head-table raised staging',
      'VIP soft-seating lounge groupings',
    ],
    packages: [
      {
        name: 'Bespoke Tablescape & Focal Styling',
        audience: 'For hosts seeking elevated visual transformation',
        summary: 'Focal backdrop, curated guest tables, and white-glove installation.',
        highlights: ['AI Concept Studio preview', 'Fresh + luxury silk floral blends', 'Full strike crew'],
      },
    ],
    faqs: [
      {
        q: 'Do you offer both fresh floral design and architectural faux installations?',
        a: 'Yes. We design primarily with fresh seasonal blooms and can incorporate luxury botanical structures where venue timelines or climate demand.',
      },
    ],
    relatedIds: ['wedding-planning', 'event-lighting', 'event-rentals'],
  },
  {
    id: 'photography-videography',
    slug: 'photography-and-videography',
    number: '08',
    title: 'Photography and Videography',
    shortTitle: 'Photo & Video',
    category: 'Design & Production',
    tagline: 'Editorial still photography and timeless 4K highlight cinematography.',
    description:
      'Vetted visual storytellers working seamlessly alongside our design team to capture architectural details, candid emotion, and polished portraits.',
    heroImage: IMG_WEDDING_FLORAL,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Lead editorial photographer and/or cinema director',
      'Pre-event shot list aligned with design installations',
      'Color-graded digital gallery and archival delivery',
      'Coordinated lighting checks with our production team',
    ],
    enhancements: [
      'Second photographer & drone aerial venue coverage',
      'Same-week preview selects for press or social release',
      'Heirloom linen-bound album design',
    ],
    packages: [
      {
        name: 'Editorial Coverage Suite',
        audience: 'For weddings, galas, and private milestones',
        summary: '6 to 10 hours of cohesive still and motion coverage.',
        highlights: ['Curated shot list', 'Private client gallery delivery', 'Full commercial/personal rights'],
      },
    ],
    faqs: [
      {
        q: 'Why book photography through Celebration Sisters?',
        a: 'Our media teams know how our lighting and floral compositions are built, ensuring every tablescape and emotional moment is lit cleanly.',
      },
    ],
    relatedIds: ['photo-booths', 'wedding-planning', 'corporate-events'],
  },
  {
    id: 'dj-entertainment',
    slug: 'dj-entertainment-and-hosting',
    number: '09',
    title: 'DJ, Entertainment and Hosting',
    shortTitle: 'DJ & Hosting',
    category: 'Entertainment & Logistics',
    tagline: 'Poised bilingual/charismatic MCs, curated soundtracks, and concert-grade audio.',
    description:
      'Music and pacing shape how guests remember an evening. Our vetted DJs and hosts maintain refined energy from cocktail hour through the final dance.',
    heroImage: IMG_LOUNGE_LIGHTING,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Professional DJ & polished Master of Ceremonies',
      'Custom ceremony, cocktail, dinner, and dance-floor music curation',
      'Clean wireless microphones for toasts and keynote speakers',
      'Discrete booth facades matching event decor',
    ],
    enhancements: [
      'Live string quartet or saxophonist accompaniment',
      'Custom cloud-floor first dance production',
      'Multi-zone outdoor/indoor distributed audio',
    ],
    packages: [
      {
        name: 'Refined Reception Sound & MC',
        audience: 'For weddings, galas, and milestone parties',
        summary: 'Complete audio engineering, custom playlist planning, and timeline hosting.',
        highlights: ['Dual sound zones', 'Wireless lapel & handheld mics', 'Clean aesthetic booth'],
      },
    ],
    faqs: [
      {
        q: 'Can clients submit must-play and do-not-play lists?',
        a: 'Yes—inside your Private Client Portal, you can collaborate directly on music cues, entrance songs, and mood preferences.',
      },
    ],
    relatedIds: ['event-lighting', 'photo-booths', 'birthdays-milestones'],
  },
  {
    id: 'photo-booths',
    slug: 'photo-booths-and-guest-experiences',
    number: '10',
    title: 'Photo Booths and Guest Experiences',
    shortTitle: 'Photo Booths',
    category: 'Entertainment & Logistics',
    tagline: 'Studio-lit DSLR portrait booths, 360 video stages, and bespoke floral backdrops.',
    description:
      'Guest experiences styled to blend naturally into luxury rooms—featuring flattering studio strobes, instant prints, and custom-designed floral backdrops.',
    heroImage: IMG_LOUNGE_LIGHTING,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Dedicated on-site booth concierge',
      'Custom event monogrammed print and digital frame overlay',
      'Instant SMS/QR gallery sharing plus unlimited physical prints',
      'Coordinated designer backdrop integration',
    ],
    enhancements: [
      '360 slow-motion editorial video platform',
      'Audio guestbook vintage telephone station',
      'Black-and-white studio Glam Filter mode',
    ],
    packages: [
      {
        name: 'Studio Glam Portrait Station',
        audience: 'For weddings, corporate galas, and showers',
        summary: '4-hour studio-lit open-air booth with custom print template and floral backdrop.',
        highlights: ['On-site attendant', 'Unlimited 4x6 prints', 'Full digital gallery'],
      },
    ],
    faqs: [
      {
        q: 'How much floor space does the portrait booth require?',
        a: 'An 8x8 ft footprint with standard 110V power access accommodates our open-air DSLR studio and backdrop comfortably.',
      },
    ],
    relatedIds: ['luxury-decor', 'photography-videography', 'dj-entertainment'],
  },
  {
    id: 'event-lighting',
    slug: 'event-lighting-and-production',
    number: '11',
    title: 'Event Lighting and Production',
    shortTitle: 'Lighting & AV',
    category: 'Entertainment & Logistics',
    tagline: 'Architectural uplighting, pinpoint table spots, chandeliers, and stage production.',
    description:
      'Lighting transforms architecture after dusk. We design warm amber washes, royal purple accents, pinpoint floral spotlighting, and clean stage illumination.',
    heroImage: IMG_CORPORATE_GALA,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Wireless architectural LED uplighting calibrated to your palette',
      'Pin-spotting for centerpieces, cakes, and head tables',
      'Custom monogram or texture projection (gobo)',
      'On-site lighting technician throughout live program',
    ],
    enhancements: [
      'Crystal chandelier and canopy string-light rigging',
      'Intelligent dance-floor moving-head wash programming',
      'Stage LED screen & keynote confidence monitors',
    ],
    packages: [
      {
        name: 'Architectural Ambience Suite',
        audience: 'For ballrooms, tents, and historic halls',
        summary: 'Full room perimeter uplighting plus centerpiece and cake pin-spotting.',
        highlights: ['DMX scene transitions', 'Clean cable concealment', 'Technician included'],
      },
    ],
    faqs: [
      {
        q: 'Do you coordinate ceiling rigging approvals with historic Columbia venues?',
        a: 'Yes. We conduct venue walkthroughs and submit technical rigging plots directly to venue management.',
      },
    ],
    relatedIds: ['luxury-decor', 'corporate-events', 'dj-entertainment'],
  },
  {
    id: 'event-rentals',
    slug: 'event-rentals-and-logistics',
    number: '12',
    title: 'Event Rentals and Logistics',
    shortTitle: 'Rentals & Logistics',
    category: 'Entertainment & Logistics',
    tagline: 'Curated velvet lounges, champagne-gold seating, custom arches, and white-glove transport.',
    description:
      'Direct access to our Columbia, SC warehouse of luxury velvet lounge sets, gold chiavari and cross-back seating, architectural backdrops, and bespoke tableware.',
    heroImage: IMG_LOUNGE_LIGHTING,
    startingGuidance: 'Custom tailored following consultation',
    inclusions: [
      'Real-time inventory allocation reserved exclusively for your date',
      'White-glove climate-controlled delivery and placement',
      'Steamed linens and inspected crystal/gold tableware',
      'Scheduled late-night or next-morning strike logistics',
    ],
    enhancements: [
      'Custom-built bar facades and champagne shelving',
      'Boucle and plum velvet VIP lounge vignettes',
      'Clear-span tent flooring and climate staging coordination',
    ],
    packages: [
      {
        name: 'Curated Lounge & Seating Package',
        audience: 'For planners, venues, and private hosts',
        summary: 'Complete VIP seating vignette paired with delivery, placement, and retrieval.',
        highlights: ['Pristine inspected stock', 'Floor-plan placement', 'Dedicated logistics crew'],
      },
    ],
    faqs: [
      {
        q: 'Can rental items be reserved standalone without full-service planning?',
        a: 'Yes, qualifying rental minimums are available for direct delivery across Columbia and surrounding counties, subject to date availability.',
      },
    ],
    relatedIds: ['luxury-decor', 'event-lighting', 'corporate-events'],
  },
];

export const PORTFOLIO_ITEMS: PortfolioItem[] = [
  {
    id: 'port-lace-house-gala',
    title: 'Governor’s Mansion Ballroom Reception',
    category: 'Weddings',
    location: 'Columbia, SC',
    venue: 'Historic Southern Estate Ballroom',
    guestCount: 220,
    season: 'Autumn',
    image: HERO_BALLROOM_IMAGE,
    caption: 'Tall champagne-gold floral towers with ivory garden roses, royal purple silk napkins, and crystal chandelier candlelight.',
    servicesUsed: ['Wedding Planning & Design', 'Luxury Decor & Styling', 'Event Lighting'],
    isVerifiedPortfolioPhoto: true,
  },
  {
    id: 'port-courtyard-vows',
    title: 'Historic Courtyard Floral Ceremony',
    category: 'Weddings',
    location: 'Lexington, SC',
    venue: 'Sandstone Estate Courtyard',
    guestCount: 165,
    season: 'Spring',
    image: IMG_WEDDING_FLORAL,
    caption: 'Sculptural asymmetric floral arch of white peonies and olive branches framed by brass hurricane lanterns.',
    servicesUsed: ['Wedding Planning & Design', 'Photography & Videography'],
    isVerifiedPortfolioPhoto: true,
  },
  {
    id: 'port-milestone-dinner',
    title: 'Candlelit 40th Milestone Estate Dinner',
    category: 'Social & Milestones',
    location: 'Lake Murray, SC',
    venue: 'Private Waterfront Residence',
    guestCount: 48,
    season: 'Winter',
    image: IMG_MILESTONE_SOIREE,
    caption: 'Ivory draped linen tablescape with brushed gold flatware, deep plum ranunculus accents, and tapered beeswax candles.',
    servicesUsed: ['Birthdays & Milestones', 'Luxury Decor & Styling', 'Rentals & Logistics'],
    isVerifiedPortfolioPhoto: true,
  },
  {
    id: 'port-corporate-summit',
    title: 'Annual Leadership & Brand Gala',
    category: 'Corporate & Brand',
    location: 'Columbia, SC',
    venue: 'Columbia Metropolitan Convention Hall',
    guestCount: 380,
    season: 'Fall',
    image: IMG_CORPORATE_GALA,
    caption: 'Full keynote stage production illuminated in warm champagne gold and royal purple architectural washes.',
    servicesUsed: ['Corporate Events', 'Promotional & Brand Events', 'Lighting & Production'],
    isVerifiedPortfolioPhoto: true,
  },
  {
    id: 'port-vip-lounge',
    title: 'Velvet Lounge & Orchid Photo Salon',
    category: 'Lighting & Lounge',
    location: 'Charleston, SC',
    venue: 'Atelier Conservatory',
    guestCount: 190,
    season: 'Summer',
    image: IMG_LOUNGE_LIGHTING,
    caption: 'Plum velvet and ivory boucle curved seating paired with a gold geometric arch and studio-lit portrait station.',
    servicesUsed: ['Photo Booths & Guest Experiences', 'Event Rentals & Logistics', 'DJ & Hosting'],
    isVerifiedPortfolioPhoto: true,
  },
];

export const SIGNATURE_EXPERIENCE_STEPS = [
  {
    step: '01',
    title: 'Discovery',
    description: 'An unhurried consultation in Columbia or virtually—clarifying your guest count, venue, priorities, and vision.',
  },
  {
    step: '02',
    title: 'Design',
    description: 'Bespoke mood boards, textile pairings, floral concepts, and AI Concept Studio previews refined until approved.',
  },
  {
    step: '03',
    title: 'Planning',
    description: 'Itemized quotations, vetted vendor alignment, inventory reservation, and milestone checklists inside your Client Portal.',
  },
  {
    step: '04',
    title: 'Execution',
    description: 'White-glove load-in, lighting calibration, floral installation, and discreet timeline management by our production leads.',
  },
  {
    step: '05',
    title: 'Celebration',
    description: 'You and your guests experience every moment effortlessly while our team orchestrates every cue through final strike.',
  },
];

export const APPROVED_TESTIMONIALS = [
  {
    id: 'test-1',
    quote:
      'Celebration Sisters transformed our reception room in Columbia into something timeless. Every candle, linen fold, and timeline cue happened seamlessly—we actually enjoyed our own wedding.',
    author: 'Camille & Jordan Mercer',
    event: 'Autumn Ballroom Wedding · 210 Guests · Columbia, SC',
  },
  {
    id: 'test-2',
    quote:
      'From our initial Concept Studio mood board through keynote stage lighting for 350 executives, their communication, itemized billing, and vendor coordination were immaculate.',
    author: 'Elena Vance, VP of Operations',
    event: 'Palmetto Health Leadership Gala · 350 Guests · Columbia, SC',
  },
  {
    id: 'test-3',
    quote:
      'They styled my mother’s 60th anniversary dinner at Lake Murray with quiet elegance—plum florals, champagne-gold chargers, and warm hospitality our family will cherish forever.',
    author: 'Marcus & Simone Ellington',
    event: 'Private Milestone Dinner · 52 Guests · Lake Murray, SC',
  },
];

export const SERVICE_LOCATIONS = [
  { city: 'Columbia, SC', note: 'Headquarters, Design Atelier & Rental Warehouse' },
  { city: 'Lexington & Lake Murray, SC', note: 'Waterfront Estates, Vineyards & Private Clubs' },
  { city: 'Irmo & Chapin, SC', note: 'Garden Receptions & Milestone Residences' },
  { city: 'Charleston & Savannah', note: 'Historic Courtyards & Destination Weddings' },
  { city: 'Greenville & Charlotte, NC', note: 'Corporate Galas & Ballroom Productions' },
];
