import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";
import OpenAI from "openai";
import { z } from "zod";
import { deployStudentWorkspace, RenderDeploymentError } from "@/lib/renderDeployer";

export const runtime = "nodejs";

type BookAndNoteRow = {
  id: string;
  fingerprint_hash: string;
  raw_text?: string;
};

type EducationalGapRow = {
  id: string;
  note_id: string;
};

type MissingConcept = {
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
};

type VerifiedResource = {
  title: string;
  url: string;
  citation: string;
  source_domain: string;
  supports: string;
};

type EducationalAudit = {
  missing_concepts: MissingConcept[];
  verified_resources: VerifiedResource[];
};

type GroundingResource = {
  query: string;
  title: string;
  url: string;
  content: string;
  score: number;
  source_domain: string;
};

type IngestSuccessResponse = {
  success: true;
  id: string;
  token: string;
  dashboard_path: string;
  educational_gap_id: string;
  missing_concepts_count: number;
  verified_resources_count: number;
  render_workspace?: {
    serviceId: string;
    serviceName: string;
    serviceUrl: string | null;
    deployId: string | null;
  } | null;
  render_warning?: string;
};

type IngestErrorResponse = {
  success: false;
  error: string;
  details?: unknown;
};

type JwtClaims = {
  fingerprint_hash: string;
  device_id: string;
  role: "authenticated";
  scope: "paperloom:fingerprint";
};

const ingestPayloadSchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  fingerprint_hash: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{64}$/, "fingerprint_hash must be a 64-character SHA-256 hex digest")
    .transform((value) => value.toLowerCase()),
  raw_text: z.string().trim().min(1).max(500_000),
});

const tavilySearchResultSchema = z.object({
  title: z.string().default("Untitled source"),
  url: z.string().url(),
  content: z.string().default(""),
  score: z.number().catch(0),
});

const tavilySearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(tavilySearchResultSchema).default([]),
});

const educationalAuditSchema = z.object({
  missing_concepts: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(1_500),
        severity: z.enum(["low", "medium", "high", "critical"]),
      }),
    )
    .max(12),
  verified_resources: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(240),
        url: z.string().url(),
        citation: z.string().trim().min(1).max(1_000),
        source_domain: z.string().trim().min(1).max(120),
        supports: z.string().trim().min(1).max(1_000),
      }),
    )
    .max(12),
});

const educationalAuditJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    missing_concepts: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
          },
          description: {
            type: "string",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
        },
        required: ["title", "description", "severity"],
      },
    },
    verified_resources: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 240,
          },
          url: {
            type: "string",
          },
          citation: {
            type: "string",
          },
          source_domain: {
            type: "string",
          },
          supports: {
            type: "string",
          },
        },
        required: ["title", "url", "citation", "source_domain", "supports"],
      },
    },
  },
  required: ["missing_concepts", "verified_resources"],
} as const;

const TRUSTED_EDUCATIONAL_DOMAINS = [
  "openstax.org",
  "khanacademy.org",
  "ck12.org",
  "libretexts.org",
  "mit.edu",
  "ocw.mit.edu",
  "ncert.nic.in",
  "cbseacademic.nic.in",
  "collegeboard.org",
  "britannica.com",
  "physicsclassroom.com",
  "nist.gov",
  "ed.gov",
  "education.gov",
  "nationalgeographic.org",
  "nature.com",
  "science.org",
];

const STOP_WORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "being",
  "between",
  "chapter",
  "could",
  "does",
  "each",
  "from",
  "have",
  "into",
  "more",
  "most",
  "other",
  "paperloom",
  "scan",
  "should",
  "student",
  "students",
  "than",
  "that",
  "their",
  "then",
  "there",
  "these",
  "this",
  "through",
  "using",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

const CURRICULUM_AUDITOR_SYSTEM_PROMPT = `You are PaperLoom's curriculum auditor.

Your job is to compare a student's scanned notes against reliable, current educational sources and curriculum-style references retrieved from Tavily.

Audit rules:
1. Identify omissions, logical fallacies, misconceptions, stale facts, ambiguous formulas, missing assumptions, or incomplete causal explanations.
2. Use only the provided Tavily grounding results as external evidence. Do not invent URLs, citations, standards, textbooks, or facts.
3. Prefer curriculum-significant gaps over minor wording preferences.
4. When the student text is broadly correct, return a small number of high-value missing concepts instead of manufacturing errors.
5. Every verified resource must cite a URL present in the Tavily grounding data.
6. Keep descriptions precise, student-facing, and actionable.
7. Severity means:
   - low: helpful refinement or vocabulary clarification.
   - medium: missing supporting concept that may affect problem solving.
   - high: misconception or omission likely to cause wrong answers.
   - critical: unsafe, fundamentally false, or severely outdated information.

Return only valid JSON that matches the requested schema.`;

function jsonResponse<T extends IngestSuccessResponse | IngestErrorResponse>(
  body: T,
  status: number,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

function createSupabaseServiceClient(): SupabaseClient {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const supabaseServiceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: getRequiredEnv("OPENAI_API_KEY"),
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractSignificantTerms(rawText: string): string[] {
  const counts = new Map<string, number>();
  const tokens = rawText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([term]) => term);
}

function inferSubjectHint(rawText: string): string {
  const lowerText = rawText.toLowerCase();

  if (
    /\b(electric|charge|voltage|current|resistance|ohm|magnetic|faraday|coulomb|induction|circuit)\b/.test(
      lowerText,
    )
  ) {
    return "electricity magnetism circuits electromagnetic induction";
  }

  if (/\b(photosynthesis|cell|genetics|evolution|ecosystem|dna|protein|organism)\b/.test(lowerText)) {
    return "biology curriculum core concepts";
  }

  if (/\b(atom|molecule|reaction|stoichiometry|acid|base|bond|periodic|enthalpy)\b/.test(lowerText)) {
    return "chemistry curriculum core concepts";
  }

  if (/\b(derivative|integral|function|equation|matrix|vector|probability|theorem)\b/.test(lowerText)) {
    return "mathematics curriculum core concepts";
  }

  const significantTerms = extractSignificantTerms(rawText);
  return significantTerms.length > 0 ? significantTerms.slice(0, 8).join(" ") : "general education curriculum concepts";
}

function buildTargetedSearchQueries(rawText: string): string[] {
  const subjectHint = inferSubjectHint(rawText);
  const significantTerms = extractSignificantTerms(rawText).slice(0, 8).join(" ");
  const topicPhrase = significantTerms.length > 0 ? `${subjectHint} ${significantTerms}` : subjectHint;

  return Array.from(
    new Set([
      `${subjectHint} curriculum syllabus learning objectives`,
      `${topicPhrase} common student misconceptions omissions`,
      `${topicPhrase} authoritative textbook explanation formulas`,
      `${subjectHint} open educational resources lesson standards`,
    ]),
  );
}

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

async function searchTavily(query: string): Promise<GroundingResource[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getRequiredEnv("TAVILY_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "advanced",
      chunks_per_source: 3,
      max_results: 5,
      include_answer: "basic",
      include_raw_content: false,
      include_domains: TRUSTED_EDUCATIONAL_DOMAINS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Tavily search failed for "${query}" with ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  const parsed = tavilySearchResponseSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(`Tavily returned an unexpected response for "${query}"`);
  }

  return parsed.data.results
    .filter((result) => result.content.trim().length > 0)
    .map((result) => ({
      query: parsed.data.query,
      title: result.title,
      url: result.url,
      content: normalizeWhitespace(result.content).slice(0, 1_800),
      score: result.score,
      source_domain: getDomainFromUrl(result.url),
    }));
}

async function gatherEducationalGrounding(rawText: string): Promise<GroundingResource[]> {
  const queries = buildTargetedSearchQueries(rawText);
  const settledResults = await Promise.allSettled(queries.map((query) => searchTavily(query)));
  const resources = settledResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const uniqueResources = new Map<string, GroundingResource>();

  for (const resource of resources) {
    const existing = uniqueResources.get(resource.url);

    if (!existing || resource.score > existing.score) {
      uniqueResources.set(resource.url, resource);
    }
  }

  const sortedResources = Array.from(uniqueResources.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (sortedResources.length === 0) {
    const failures = settledResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));

    throw new Error(`No Tavily grounding resources were available. ${failures.join(" ")}`.trim());
  }

  return sortedResources;
}

function buildGroundingContext(resources: GroundingResource[]): string {
  return resources
    .map((resource, index) => {
      return [
        `SOURCE ${index + 1}`,
        `Query: ${resource.query}`,
        `Title: ${resource.title}`,
        `URL: ${resource.url}`,
        `Domain: ${resource.source_domain}`,
        `Relevance score: ${resource.score}`,
        `Content: ${resource.content}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildAuditUserPrompt(rawText: string, groundingResources: GroundingResource[]): string {
  return [
    "STUDENT_SCAN_RAW_TEXT:",
    normalizeWhitespace(rawText).slice(0, 60_000),
    "",
    "TAVILY_GROUNDING_RESULTS:",
    buildGroundingContext(groundingResources),
    "",
    "TASK:",
    "Compare the student scan to the Tavily grounding results. Identify missing concepts, misconceptions, logical gaps, outdated facts, and useful verified resources. Return strict JSON only.",
  ].join("\n");
}

function coerceAuditResourcesToTavilyUrls(
  audit: EducationalAudit,
  groundingResources: GroundingResource[],
): EducationalAudit {
  const resourceByUrl = new Map(groundingResources.map((resource) => [resource.url, resource]));
  const verifiedResources = audit.verified_resources
    .map((resource) => {
      const grounding = resourceByUrl.get(resource.url);

      if (!grounding) {
        return null;
      }

      return {
        title: resource.title || grounding.title,
        url: grounding.url,
        citation: resource.citation,
        source_domain: grounding.source_domain,
        supports: resource.supports,
      };
    })
    .filter((resource): resource is VerifiedResource => resource !== null);

  return {
    missing_concepts: audit.missing_concepts,
    verified_resources: verifiedResources,
  };
}

async function auditRawTextWithOpenAI(
  rawText: string,
  groundingResources: GroundingResource[],
): Promise<EducationalAudit> {
  const openai = createOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: getOptionalEnv("OPENAI_MODEL", "gpt-5.6-terra"),
    messages: [
      {
        role: "system",
        content: CURRICULUM_AUDITOR_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildAuditUserPrompt(rawText, groundingResources),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "paperloom_educational_audit",
        strict: true,
        schema: educationalAuditJsonSchema,
      },
    },
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned an empty curriculum audit response");
  }

  let json: unknown;

  try {
    json = JSON.parse(content);
  } catch {
    throw new Error("OpenAI curriculum audit response was not valid JSON");
  }

  const parsed = educationalAuditSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(`OpenAI curriculum audit failed schema validation: ${parsed.error.message}`);
  }

  return coerceAuditResourcesToTavilyUrls(parsed.data, groundingResources);
}

async function runEducationalValidationPipeline(rawText: string): Promise<EducationalAudit> {
  const groundingResources = await gatherEducationalGrounding(rawText);
  return auditRawTextWithOpenAI(rawText, groundingResources);
}

async function findExistingNote(
  supabase: SupabaseClient,
  fingerprintHash: string,
): Promise<BookAndNoteRow | null> {
  const { data, error } = await supabase
    .from("books_and_notes")
    .select("id, fingerprint_hash, raw_text")
    .eq("fingerprint_hash", fingerprintHash)
    .maybeSingle<BookAndNoteRow>();

  if (error) {
    throw new Error(`Failed to query books_and_notes: ${error.message}`);
  }

  return data;
}

async function insertNote(
  supabase: SupabaseClient,
  payload: z.infer<typeof ingestPayloadSchema>,
): Promise<BookAndNoteRow> {
  const { data, error } = await supabase
    .from("books_and_notes")
    .insert({
      fingerprint_hash: payload.fingerprint_hash,
      raw_text: payload.raw_text,
    })
    .select("id, fingerprint_hash, raw_text")
    .single<BookAndNoteRow>();

  if (!error && data) {
    return data;
  }

  if (error?.code === "23505") {
    const existingNote = await findExistingNote(supabase, payload.fingerprint_hash);

    if (existingNote) {
      return existingNote;
    }
  }

  throw new Error(`Failed to insert books_and_notes row: ${error?.message ?? "Unknown Supabase error"}`);
}

async function findExistingEducationalGapId(
  supabase: SupabaseClient,
  noteId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("educational_gaps")
    .select("id")
    .eq("note_id", noteId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to query educational_gaps: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0 ? String(data[0].id) : null;
}

async function saveEducationalAudit(
  supabase: SupabaseClient,
  noteId: string,
  audit: EducationalAudit,
): Promise<EducationalGapRow> {
  const existingGapId = await findExistingEducationalGapId(supabase, noteId);
  const gapPayload = {
    note_id: noteId,
    missing_concepts: audit.missing_concepts,
    verified_resources: audit.verified_resources,
    updated_at: new Date().toISOString(),
  };

  if (existingGapId) {
    const { data, error } = await supabase
      .from("educational_gaps")
      .update(gapPayload)
      .eq("id", existingGapId)
      .select("id, note_id")
      .single<EducationalGapRow>();

    if (error || !data) {
      throw new Error(`Failed to update educational_gaps row: ${error?.message ?? "No row returned"}`);
    }

    return data;
  }

  const { data, error } = await supabase
    .from("educational_gaps")
    .insert(gapPayload)
    .select("id, note_id")
    .upsert(gapPayload, {
      onConflict: "note_id",
    })
    .select("id, note_id")
    .single<EducationalGapRow>();

  if (error || !data) {
    throw new Error(`Failed to upsert educational_gaps row: ${error?.message ?? "No row returned"}`);
  }

  return data;
}

function shouldDeployRenderWorkspace(): boolean {
  return process.env.RENDER_AUTODEPLOY_WORKSPACES === "true";
}

async function maybeDeployRenderWorkspace(note: BookAndNoteRow): Promise<{
  renderWorkspace: IngestSuccessResponse["render_workspace"];
  renderWarning?: string;
}> {
  if (!shouldDeployRenderWorkspace()) {
    return {
      renderWorkspace: null,
    };
  }

  try {
    const deployment = await deployStudentWorkspace(note.fingerprint_hash, note.id);

    return {
      renderWorkspace: {
        serviceId: deployment.serviceId,
        serviceName: deployment.serviceName,
        serviceUrl: deployment.serviceUrl,
        deployId: deployment.deployId,
      },
    };
  } catch (error) {
    const message =
      error instanceof RenderDeploymentError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Render workspace deployment failed";

    console.error("PaperLoom Render deployment warning:", error);

    return {
      renderWorkspace: null,
      renderWarning: message,
    };
  }
}

function createFingerprintJwt(payload: z.infer<typeof ingestPayloadSchema>): string {
  const jwtSecret: Secret = getRequiredEnv("SUPABASE_JWT_SECRET");
  const claims: JwtClaims = {
    fingerprint_hash: payload.fingerprint_hash,
    device_id: payload.device_id,
    role: "authenticated",
    scope: "paperloom:fingerprint",
  };

  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: "10m",
    issuer: "paperloom-ingest",
    audience: "authenticated",
    subject: payload.fingerprint_hash,
    jwtid: crypto.randomUUID(),
  };

  return jwt.sign(claims, jwtSecret, options);
}

async function parseJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SyntaxError("Request body must be valid JSON");
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request);
    const parsedPayload = ingestPayloadSchema.safeParse(body);

    if (!parsedPayload.success) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid ingest payload",
          details: parsedPayload.error.flatten(),
        },
        400,
      );
    }

    const payload = parsedPayload.data;
    const supabase = createSupabaseServiceClient();
    const existingNote = await findExistingNote(supabase, payload.fingerprint_hash);
    const note = existingNote ?? (await insertNote(supabase, payload));
    const rawTextForAudit = existingNote?.raw_text && existingNote.raw_text.trim().length > 0 ? existingNote.raw_text : payload.raw_text;
    const educationalAudit = await runEducationalValidationPipeline(rawTextForAudit);
    const educationalGap = await saveEducationalAudit(supabase, note.id, educationalAudit);
    const { renderWorkspace, renderWarning } = await maybeDeployRenderWorkspace(note);
    const token = createFingerprintJwt(payload);

    return jsonResponse(
      {
        success: true,
        id: note.id,
        token,
        dashboard_path: `/dashboard/${payload.fingerprint_hash}`,
        educational_gap_id: educationalGap.id,
        missing_concepts_count: educationalAudit.missing_concepts.length,
        verified_resources_count: educationalAudit.verified_resources.length,
        render_workspace: renderWorkspace,
        render_warning: renderWarning,
      },
      200,
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(
        {
          success: false,
          error: error.message,
        },
        400,
      );
    }

    const message = error instanceof Error ? error.message : "Unexpected ingest route failure";

    console.error("PaperLoom ingest error:", error);

    return jsonResponse(
      {
        success: false,
        error: "Internal server error",
        details: process.env.NODE_ENV === "production" ? undefined : message,
      },
      500,
    );
  }
}
