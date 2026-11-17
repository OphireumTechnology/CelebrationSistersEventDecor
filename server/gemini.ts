import { GoogleGenAI, Type } from '@google/genai';

const AI_MODEL_ID = 'gemini-4-hydrogen';
const AI_REQUEST_TIMEOUT_MS = 18_000;

export function getGeminiConfigStatus() {
  return {
    model: AI_MODEL_ID,
    configured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0),
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
  };
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`AI_TIMEOUT: ${label} exceeded ${timeoutMs}ms timeout.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ConciergeStructuredOutput {
  reply: string;
  extractedLead: {
    eventCategory: string;
    eventDate: string;
    location: string;
    guestCount: number | null;
    theme: string;
    budgetRange: string;
    recommendedDivisions: string[];
    needsHumanEscalation: boolean;
    summary: string;
  };
}

export async function runConciergeTurn(
  history: { role: 'user' | 'assistant'; content: string }[],
  userMessage: string,
): Promise<ConciergeStructuredOutput> {
  const ai = getGeminiClient();
  const startedAt = Date.now();

  const conversationTranscript = history
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'Client' : 'Concierge'}: ${m.content}`)
    .join('\n');

  const prompt = `${conversationTranscript ? `Conversation so far:\n${conversationTranscript}\n\n` : ''}Client: ${userMessage}`;

  const response = await withTimeout(
    ai.models.generateContent({
      model: AI_MODEL_ID,
      contents: prompt,
      config: {
        systemInstruction: `You are the AI Event Concierge for Celebration Sisters Event Decor, a luxury event planning, decoration, coordination, and production studio headquartered in Columbia, South Carolina (serving Columbia, Lexington, Lake Murray, Irmo, Charleston, Greenville, and Charlotte).

Your tone: poised, warm, minimalist luxury hospitality — never robotic, never pushy.

Approved 12 Service Divisions (recommend ONLY from these):
01. Wedding Planning and Design
02. Baby Showers and Gender Reveals
03. Birthdays and Milestone Celebrations
04. Anniversaries and Private Events
05. Corporate Events
06. Promotional and Brand Events
07. Luxury Event Decoration and Styling
08. Photography and Videography
09. DJ, Entertainment and Hosting
10. Photo Booths and Guest Experiences
11. Event Lighting and Production
12. Event Rentals and Logistics

Your goals in conversation:
1. Identify the event category and gently gather target date, city/venue location, approximate guest count, aesthetic theme/colors, and general investment range.
2. Recommend relevant Celebration Sisters divisions and explain consultation-based custom packages.
3. Encourage scheduling a human consultation or creating a lead profile.

CRITICAL SAFETY & AUTHORITY RULES (NEVER VIOLATE):
- NEVER invent, quote, or guarantee exact company prices or package dollar figures. Always explain that finalized pricing is itemized following a human consultation.
- NEVER guarantee event date availability. Explain that availability is confirmed only after backend date verification by our planning team.
- NEVER confirm bookings independently, execute contracts, or process payments.
- NEVER claim to have access to private customer records.
- If the client asks for binding contract changes, custom discounts, immediate booking confirmation, or urgent human help, set needsHumanEscalation=true and offer immediate transfer to our Columbia planning directors.

Keep your reply concise (2 to 4 crisp sentences) and helpful.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: { type: Type.STRING, description: 'Natural, poised concierge response to the client.' },
            extractedLead: {
              type: Type.OBJECT,
              properties: {
                eventCategory: { type: Type.STRING, description: 'Identified service division or Unknown' },
                eventDate: { type: Type.STRING, description: 'Target date or timeframe if mentioned, else Unspecified' },
                location: { type: Type.STRING, description: 'City or venue if mentioned, else Columbia, SC area' },
                guestCount: { type: Type.INTEGER, nullable: true, description: 'Estimated guest count if stated, else null' },
                theme: { type: Type.STRING, description: 'Theme, style, or color preferences if mentioned, else Unspecified' },
                budgetRange: { type: Type.STRING, description: 'Budget range if stated, else To be discussed in consultation' },
                recommendedDivisions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '1 to 4 matching Celebration Sisters service division names.',
                },
                needsHumanEscalation: { type: Type.BOOLEAN, description: 'True if client wants a human planner or asks for binding price/date guarantees.' },
                summary: { type: Type.STRING, description: '1-sentence internal planner brief summarizing this lead.' },
              },
              required: [
                'eventCategory',
                'eventDate',
                'location',
                'theme',
                'budgetRange',
                'recommendedDivisions',
                'needsHumanEscalation',
                'summary',
              ],
            },
          },
          required: ['reply', 'extractedLead'],
        },
      },
    }),
    AI_REQUEST_TIMEOUT_MS,
    'AI Event Concierge',
  );

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('Empty response received from Gemini Concierge.');
  }
  const parsed = JSON.parse(text) as ConciergeStructuredOutput;
  console.info(
    JSON.stringify({
      event: 'ai_concierge_turn',
      model: AI_MODEL_ID,
      durationMs: Date.now() - startedAt,
      escalation: parsed.extractedLead.needsHumanEscalation,
    }),
  );
  return parsed;
}

export interface ConceptStudioProposal {
  themeName: string;
  visionSummary: string;
  colorPalette: { name: string; hex: string; usage: string }[];
  floralConcept: string;
  tableArrangement: string;
  stageBackdrop: string;
  lightingPlan: string;
  recommendedDivisions: string[];
}

export async function generateConceptProposal(input: {
  eventType: string;
  guestCount: number;
  venueStyle: string;
  preferredPalette: string;
  visionDescription: string;
}): Promise<ConceptStudioProposal> {
  const ai = getGeminiClient();
  const startedAt = Date.now();

  const response = await withTimeout(
    ai.models.generateContent({
      model: AI_MODEL_ID,
      contents: `Design a luxury event concept proposal for Celebration Sisters Event Decor (Columbia, SC).
Event Category: ${input.eventType}
Guest Count: ${input.guestCount}
Venue Setting: ${input.venueStyle}
Preferred Palette / Accents: ${input.preferredPalette}
Client Vision: ${input.visionDescription}`,
      config: {
        systemInstruction: `You are the Lead Concept Architect for Celebration Sisters Event Decor. Transform the client's natural-language event description into a refined, cohesive, quiet-luxury design proposal.
- Respect luxury taste: understated elegance, intentional color harmony (4 cohesive hex colors with exact usage guidance), rich botanical textures, balanced tablescapes, architectural backdrops, and warm atmospheric lighting.
- Never include pricing figures or availability guarantees.
- Return valid JSON matching the schema.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            themeName: { type: Type.STRING, description: 'Poetic 2-4 word luxury theme title.' },
            visionSummary: { type: Type.STRING, description: '2-3 sentence editorial summary of the design direction.' },
            colorPalette: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  hex: { type: Type.STRING, description: 'Valid 6-digit hex code like #4B2087' },
                  usage: { type: Type.STRING },
                },
                required: ['name', 'hex', 'usage'],
              },
            },
            floralConcept: { type: Type.STRING, description: 'Specific floral varieties, vessels, and arrangement architecture.' },
            tableArrangement: { type: Type.STRING, description: 'Linen, charger, flatware, napkin, and candle layout.' },
            stageBackdrop: { type: Type.STRING, description: 'Head table, ceremony focal, or stage backdrop design.' },
            lightingPlan: { type: Type.STRING, description: 'Color temperature, pin-spotting, and atmospheric wash plan.' },
            recommendedDivisions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Matching Celebration Sisters divisions.',
            },
          },
          required: [
            'themeName',
            'visionSummary',
            'colorPalette',
            'floralConcept',
            'tableArrangement',
            'stageBackdrop',
            'lightingPlan',
            'recommendedDivisions',
          ],
        },
      },
    }),
    AI_REQUEST_TIMEOUT_MS,
    'AI Event Concept Studio',
  );

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('Empty response received from Gemini Concept Studio.');
  }
  const parsed = JSON.parse(text) as ConceptStudioProposal;
  console.info(
    JSON.stringify({
      event: 'ai_concept_proposal',
      model: AI_MODEL_ID,
      durationMs: Date.now() - startedAt,
    }),
  );
  return parsed;
}
