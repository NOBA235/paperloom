"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Severity = "critical" | "high" | "medium" | "low";

type BookAndNote = {
  id: string;
  fingerprint_hash: string;
  raw_text: string;
  created_at: string;
};

type MissingConcept = {
  title: string;
  description: string;
  severity: Severity;
};

type VerifiedResource = {
  title: string;
  url: string;
  citation: string;
  source_domain?: string;
  supports?: string;
};

type EducationalGap = {
  id: string;
  note_id: string;
  missing_concepts: MissingConcept[];
  verified_resources: VerifiedResource[];
  updated_at: string;
};

type WorkspaceData = {
  note: BookAndNote | null;
  gaps: EducationalGap | null;
};

type QuizQuestion = {
  id: string;
  severity: Severity;
  conceptTitle: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
};

type LoadingState = "idle" | "loading" | "ready" | "missing-token" | "not-found" | "error";

const TOKEN_STORAGE_KEYS = [
  "paperloom.jwt",
  "paperloom_token",
  "paperloom:token",
  "paperloom_custom_jwt",
  "supabase.paperloom.access_token",
];

const TOKEN_COOKIE_KEYS = ["paperloom_jwt", "paperloom_token", "paperloom_access_token"];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "border-rose-300 bg-rose-50 text-rose-950 shadow-rose-100",
  high: "border-red-200 bg-red-50 text-red-950 shadow-red-100",
  medium: "border-amber-200 bg-amber-50 text-amber-950 shadow-amber-100",
  low: "border-emerald-200 bg-emerald-50 text-emerald-950 shadow-emerald-100",
};

const SEVERITY_PILL_STYLES: Record<Severity, string> = {
  critical: "bg-rose-600 text-white",
  high: "bg-red-600 text-white",
  medium: "bg-amber-500 text-amber-950",
  low: "bg-emerald-600 text-white",
};

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${encodeURIComponent(name)}=`));

  if (!cookie) {
    return null;
  }

  return decodeURIComponent(cookie.split("=").slice(1).join("="));
}

function readPaperLoomToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  for (const key of TOKEN_STORAGE_KEYS) {
    const token = window.sessionStorage.getItem(key);

    if (token && token.trim().length > 0) {
      return token.trim();
    }
  }

  for (const key of TOKEN_COOKIE_KEYS) {
    const token = readCookieValue(key);

    if (token && token.trim().length > 0) {
      return token.trim();
    }
  }

  return null;
}

function authorizedFetch(token: string, anonKey: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("apikey", anonKey);
    headers.set("Authorization", `Bearer ${token}`);

    return fetch(input, {
      ...init,
      headers,
    });
  };
}

function createAuthorizedSupabaseClient(token: string): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      fetch: authorizedFetch(token, SUPABASE_ANON_KEY),
    },
  });
}

function normalizeHashParam(value: string | string[] | undefined): string {
  const hash = Array.isArray(value) ? value[0] : value;
  return decodeURIComponent(hash ?? "").trim().toLowerCase();
}

function isValidFingerprintHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

async function fetchWorkspaceData(hash: string, token: string): Promise<WorkspaceData> {
  const supabase = createAuthorizedSupabaseClient(token);
  const { data: note, error: noteError } = await supabase
    .from("books_and_notes")
    .select("id, fingerprint_hash, raw_text, created_at")
    .eq("fingerprint_hash", hash)
    .maybeSingle<BookAndNote>();

  if (noteError) {
    throw new Error(noteError.message);
  }

  if (!note) {
    return {
      note: null,
      gaps: null,
    };
  }

  const { data: gapRows, error: gapError } = await supabase
    .from("educational_gaps")
    .select("id, note_id, missing_concepts, verified_resources, updated_at")
    .eq("note_id", note.id)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (gapError) {
    throw new Error(gapError.message);
  }

  return {
    note,
    gaps: Array.isArray(gapRows) && gapRows.length > 0 ? (gapRows[0] as EducationalGap) : null,
  };
}

function getSignificantWords(value: string): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "because",
    "between",
    "concept",
    "could",
    "from",
    "have",
    "into",
    "missing",
    "should",
    "that",
    "their",
    "there",
    "these",
    "this",
    "through",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);

  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((word) => word.replace(/^-+|-+$/g, ""))
        .filter((word) => word.length >= 5 && !stopWords.has(word)),
    ),
  ).slice(0, 24);
}

function splitIntoParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function getParagraphSeverity(paragraph: string, concepts: MissingConcept[]): Severity | null {
  const lowerParagraph = paragraph.toLowerCase();
  const matches = concepts.filter((concept) => {
    const terms = getSignificantWords(`${concept.title} ${concept.description}`).slice(0, 8);
    return terms.some((term) => lowerParagraph.includes(term));
  });

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0].severity;
}

function buildHighlightTerms(concepts: MissingConcept[]): string[] {
  return Array.from(
    new Set(
      concepts.flatMap((concept) => getSignificantWords(`${concept.title} ${concept.description}`).slice(0, 5)),
    ),
  ).slice(0, 40);
}

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) {
    return <>{text}</>;
  }

  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) => {
        const isMatch = terms.some((term) => term.toLowerCase() === part.toLowerCase());

        if (!isMatch) {
          return <span key={`${part}-${index}`}>{part}</span>;
        }

        return (
          <mark
            key={`${part}-${index}`}
            className="rounded bg-cyan-100 px-1 py-0.5 text-slate-950 ring-1 ring-cyan-200"
          >
            {part}
          </mark>
        );
      })}
    </>
  );
}

function groupConceptsBySeverity(concepts: MissingConcept[]): Record<Severity, MissingConcept[]> {
  return concepts.reduce<Record<Severity, MissingConcept[]>>(
    (groups, concept) => {
      groups[concept.severity].push(concept);
      return groups;
    },
    {
      critical: [],
      high: [],
      medium: [],
      low: [],
    },
  );
}

function generateQuizQuestions(concepts: MissingConcept[], resources: VerifiedResource[]): QuizQuestion[] {
  const sortedConcepts = [...concepts].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return sortedConcepts.slice(0, 8).map((concept, index) => {
    const resource = resources[index % Math.max(resources.length, 1)];
    const sourceLabel = resource?.source_domain ?? "the verified source";
    const conceptDescription = concept.description.replace(/\s+/g, " ").trim();

    return {
      id: `${concept.severity}-${concept.title}-${index}`,
      severity: concept.severity,
      conceptTitle: concept.title,
      question: `Which answer best repairs the learning gap around "${concept.title}"?`,
      options: [
        conceptDescription,
        "Treat the point as optional because the original scan already contains enough detail.",
        `Memorize a formula from ${sourceLabel} without connecting it to the scanned explanation.`,
        "Replace the scanned explanation with a shorter definition and skip the underlying cause.",
      ],
      correctIndex: 0,
      explanation: conceptDescription,
    };
  });
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "verified source";
  }
}

function DashboardSkeleton() {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <div className="h-24 animate-pulse rounded-lg bg-white/10" />
        <div className="grid gap-5 xl:grid-cols-[1.05fr_1.15fr_0.9fr]">
          <div className="h-[640px] animate-pulse rounded-lg bg-white/10" />
          <div className="h-[640px] animate-pulse rounded-lg bg-white/10" />
          <div className="h-[640px] animate-pulse rounded-lg bg-white/10" />
        </div>
      </div>
    </main>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <section className="w-full max-w-xl rounded-lg border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-cyan-950/40">
        <div className="mb-5 h-1.5 w-20 rounded-full bg-cyan-300" />
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">{detail}</p>
      </section>
    </main>
  );
}

function Header({ note, gapCount, resourceCount }: { note: BookAndNote; gapCount: number; resourceCount: number }) {
  return (
    <header className="overflow-hidden rounded-lg border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_34%),linear-gradient(135deg,rgba(15,23,42,0.98),rgba(30,41,59,0.92))] p-5 shadow-2xl shadow-cyan-950/30">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">PaperLoom Secure Workspace</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">AI Gap Tutor Insights</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            Physical scan {note.fingerprint_hash.slice(0, 12)}...{note.fingerprint_hash.slice(-8)}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg border border-white/10 bg-white/10 px-4 py-3">
            <p className="text-2xl font-semibold text-white">{gapCount}</p>
            <p className="mt-1 text-xs text-slate-300">Gaps</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/10 px-4 py-3">
            <p className="text-2xl font-semibold text-white">{resourceCount}</p>
            <p className="mt-1 text-xs text-slate-300">Sources</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/10 px-4 py-3">
            <p className="text-2xl font-semibold text-white">{new Date(note.created_at).toLocaleDateString()}</p>
            <p className="mt-1 text-xs text-slate-300">Scan Date</p>
          </div>
        </div>
      </div>
    </header>
  );
}

function SourceRail({ resources }: { resources: VerifiedResource[] }) {
  return (
    <div className="mt-5 space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Verified Resources</h3>
      {resources.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Grounded resources are still being prepared for this scan.
        </div>
      ) : (
        resources.slice(0, 5).map((resource) => (
          <a
            key={resource.url}
            href={resource.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-cyan-300 hover:shadow-md"
          >
            <p className="text-sm font-semibold text-slate-950">{resource.title}</p>
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">{resource.citation}</p>
            <p className="mt-3 text-xs font-medium text-cyan-700">{resource.source_domain ?? safeHostname(resource.url)}</p>
          </a>
        ))
      )}
    </div>
  );
}

function TextPanel({ note, concepts }: { note: BookAndNote; concepts: MissingConcept[] }) {
  const paragraphs = useMemo(() => splitIntoParagraphs(note.raw_text), [note.raw_text]);
  const highlightTerms = useMemo(() => buildHighlightTerms(concepts), [concepts]);

  return (
    <section className="rounded-lg border border-white/10 bg-white p-4 text-slate-950 shadow-xl shadow-slate-950/10">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-semibold">Original Textbook Scan</h2>
          <p className="mt-1 text-xs text-slate-500">{paragraphs.length} structural text blocks</p>
        </div>
        <div className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white">RLS Verified</div>
      </div>
      <div className="max-h-[680px] space-y-3 overflow-y-auto pr-2">
        {paragraphs.map((paragraph, index) => {
          const severity = getParagraphSeverity(paragraph, concepts);
          const markerClass =
            severity === "critical"
              ? "border-rose-500 bg-rose-50"
              : severity === "high"
                ? "border-red-400 bg-red-50"
                : severity === "medium"
                  ? "border-amber-400 bg-amber-50"
                  : severity === "low"
                    ? "border-emerald-400 bg-emerald-50"
                    : "border-slate-200 bg-slate-50";

          return (
            <article key={`${paragraph.slice(0, 18)}-${index}`} className={`rounded-lg border-l-4 p-4 ${markerClass}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Block {index + 1}</span>
                {severity ? (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_PILL_STYLES[severity]}`}>
                    {SEVERITY_LABELS[severity]}
                  </span>
                ) : null}
              </div>
              <p className="text-sm leading-7 text-slate-800">
                <HighlightedText text={paragraph} terms={highlightTerms} />
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function InsightsPanel({ concepts, resources }: { concepts: MissingConcept[]; resources: VerifiedResource[] }) {
  const groups = useMemo(() => groupConceptsBySeverity(concepts), [concepts]);
  const sections: Severity[] = ["critical", "high", "medium", "low"];

  return (
    <section className="rounded-lg border border-white/10 bg-white p-4 text-slate-950 shadow-xl shadow-slate-950/10">
      <div className="mb-4 border-b border-slate-200 pb-4">
        <h2 className="text-lg font-semibold">AI Gap Tutor Insights</h2>
        <p className="mt-1 text-xs text-slate-500">Prioritized from curriculum-grounded validation</p>
      </div>
      <div className="max-h-[680px] overflow-y-auto pr-2">
        {concepts.length === 0 ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
            No missing concepts were recorded for this scan yet.
          </div>
        ) : (
          <div className="space-y-5">
            {sections.map((severity) => {
              const items = groups[severity];

              if (items.length === 0) {
                return null;
              }

              return (
                <div key={severity}>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-800">{SEVERITY_LABELS[severity]} Gap Analysis</h3>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_PILL_STYLES[severity]}`}>
                      {items.length}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {items.map((concept) => (
                      <article
                        key={`${concept.severity}-${concept.title}`}
                        className={`rounded-lg border p-4 shadow-sm ${SEVERITY_STYLES[concept.severity]}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <h4 className="text-base font-semibold">{concept.title}</h4>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_PILL_STYLES[concept.severity]}`}>
                            {SEVERITY_LABELS[concept.severity]}
                          </span>
                        </div>
                        <p className="mt-3 text-sm leading-6 opacity-90">{concept.description}</p>
                      </article>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <SourceRail resources={resources} />
      </div>
    </section>
  );
}

function QuizPanel({ questions }: { questions: QuizQuestion[] }) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const answeredCount = Object.keys(answers).length;
  const correctCount = questions.filter((question) => answers[question.id] === question.correctIndex).length;
  const scorePercent = questions.length === 0 ? 0 : Math.round((correctCount / questions.length) * 100);

  return (
    <section className="rounded-lg border border-white/10 bg-white p-4 text-slate-950 shadow-xl shadow-slate-950/10">
      <div className="mb-4 border-b border-slate-200 pb-4">
        <h2 className="text-lg font-semibold">Adaptive Gap Quiz</h2>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-blue-500 to-emerald-500 transition-all"
            style={{ width: `${questions.length === 0 ? 0 : (answeredCount / questions.length) * 100}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <span>{answeredCount} of {questions.length} answered</span>
          <span>{scorePercent}% mastery</span>
        </div>
      </div>
      <div className="max-h-[680px] space-y-4 overflow-y-auto pr-2">
        {questions.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
            Quiz items will appear once the audit contains missing concepts.
          </div>
        ) : (
          questions.map((question, index) => {
            const selected = answers[question.id];
            const hasAnswered = selected !== undefined;

            return (
              <article key={question.id} className="rounded-lg border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Question {index + 1}</p>
                    <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-950">{question.question}</h3>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_PILL_STYLES[question.severity]}`}>
                    {SEVERITY_LABELS[question.severity]}
                  </span>
                </div>
                <div className="space-y-2">
                  {question.options.map((option, optionIndex) => {
                    const isSelected = selected === optionIndex;
                    const isCorrect = question.correctIndex === optionIndex;
                    const stateClass =
                      hasAnswered && isCorrect
                        ? "border-emerald-400 bg-emerald-50 text-emerald-950"
                        : hasAnswered && isSelected && !isCorrect
                          ? "border-red-300 bg-red-50 text-red-950"
                          : isSelected
                            ? "border-cyan-400 bg-cyan-50 text-cyan-950"
                            : "border-slate-200 bg-white text-slate-700 hover:border-cyan-300 hover:bg-cyan-50";

                    return (
                      <button
                        key={`${question.id}-${optionIndex}`}
                        type="button"
                        onClick={() => setAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                        className={`w-full rounded-lg border px-3 py-3 text-left text-sm leading-5 transition ${stateClass}`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
                {hasAnswered ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-700">
                    {selected === question.correctIndex ? "Correct. " : "Review this one. "}
                    {question.explanation}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const params = useParams<{ hash?: string | string[] }>();
  const hash = useMemo(() => normalizeHashParam(params.hash), [params.hash]);
  const [state, setState] = useState<LoadingState>("idle");
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadWorkspace() {
      if (!isValidFingerprintHash(hash)) {
        setState("not-found");
        return;
      }

      const token = readPaperLoomToken();

      if (!token) {
        setState("missing-token");
        return;
      }

      setState("loading");
      setError(null);

      try {
        const data = await fetchWorkspaceData(hash, token);

        if (!isMounted) {
          return;
        }

        if (!data.note) {
          setState("not-found");
          return;
        }

        setWorkspace(data);
        setState("ready");
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Unable to load the secure workspace");
        setState("error");
      }
    }

    loadWorkspace();

    return () => {
      isMounted = false;
    };
  }, [hash]);

  const concepts = workspace?.gaps?.missing_concepts ?? [];
  const resources = workspace?.gaps?.verified_resources ?? [];
  const quizQuestions = useMemo(() => generateQuizQuestions(concepts, resources), [concepts, resources]);

  if (state === "idle" || state === "loading") {
    return <DashboardSkeleton />;
  }

  if (state === "missing-token") {
    return (
      <EmptyState
        title="Secure Token Required"
        detail="This workspace is protected by the physical document fingerprint. Reopen it from the PaperLoom scan response so the short-lived cryptographic token is available."
      />
    );
  }

  if (state === "not-found") {
    return (
      <EmptyState
        title="Workspace Not Found"
        detail="No authorized note exists for this fingerprint, or the current token does not match the physical document hash."
      />
    );
  }

  if (state === "error" || !workspace || !workspace.note) {
    return (
      <EmptyState
        title="Workspace Unavailable"
        detail={error ?? "The secure dashboard could not be loaded."}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#020617,#0f172a_42%,#082f49)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <Header note={workspace.note} gapCount={concepts.length} resourceCount={resources.length} />
        <div className="grid gap-5 xl:grid-cols-[1.05fr_1.15fr_0.9fr]">
          <TextPanel note={workspace.note} concepts={concepts} />
          <InsightsPanel concepts={concepts} resources={resources} />
          <QuizPanel questions={quizQuestions} />
        </div>
      </div>
    </main>
  );
}
