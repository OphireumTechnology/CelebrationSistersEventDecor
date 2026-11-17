import { GoogleGenAI, Type } from '@google/genai';

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

  const conversationTranscript = history
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'Client' : 'Concierge'}: ${m.content}`)
    .join('\n');

  const prompt = `${conversationTranscript ? `Conversation so far:\n${conversationTranscript}\n\n` : ''}Client: ${userMessage}`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction: `You are the AI Event Concierge for Celebration Sisters Event Decor, a luxury event planning, decoration, coordination, and production studio headquartered in Columbia, South Carolina.

Your tone: poised, warm, minimalist luxury hospitality — never robotic, never pushy.

Your goals in conversation:
1. Identify event category (from our 12 divisions: Wedding Planning and Design, Baby Showers and Gender Reveals, Birthdays and Milestone Celebrations, Anniversaries and Private Events, Corporate Events, Promotional and Brand Events, Luxury Event Decoration and Styling, Photography and Videography, DJ Entertainment and Hosting, Photo Booths and Guest Experiences, Event Lighting and Production, Event Rentals and Logistics).
2. Gently gather missing key planning details: target event date, city/venue location, approximate guest count, aesthetic theme/colors, and general investment/budget range.
3. Recommend relevant Celebration Sisters divisions and explain preliminary package options at a high level.
4. Encourage scheduling a human consultation or creating a lead profile when ready.

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
  });

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('Empty response received from Gemini Concierge.');
  }
  return JSON.parse(text) as ConciergeStructuredOutput;
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

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
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
  });

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('Empty response received from Gemini Concept Studio.');
  }
  return JSON.parse(text) as ConceptStudioProposal;
}
