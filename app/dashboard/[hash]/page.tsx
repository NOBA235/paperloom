"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Home,
  ListChecks,
  PanelLeft,
  ScanLine,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

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
type WorkspaceTab = "overview" | "page" | "gaps" | "sources" | "practice";
type UiMorphState = "standard" | "bionic" | "horizon";

type UiMorphAction = {
  type: "set";
  state: UiMorphState;
};

type HorizonFocusNode = MissingConcept & {
  index: number;
  resource?: VerifiedResource;
};

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
  critical: "border-[#E9C7C7] bg-[#FEF2F2] text-[#9A3D3D]",
  high: "border-[#EAD2C8] bg-[#FFF6F1] text-[#8D4B32]",
  medium: "border-[#E4D8B8] bg-[#FFF9EA] text-[#765F24]",
  low: "border-[#C9DECE] bg-[#F1F8F3] text-[#356B45]",
};

const TAB_DEFINITIONS: Array<{ id: WorkspaceTab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "page", label: "Page", icon: FileText },
  { id: "gaps", label: "Learning gaps", icon: ListChecks },
  { id: "sources", label: "Sources", icon: ExternalLink },
  { id: "practice", label: "Practice", icon: Check },
];

const UI_MORPH_OPTIONS: Array<{ id: UiMorphState; label: string; icon: LucideIcon }> = [
  { id: "standard", label: "Standard", icon: BookOpen },
  { id: "bionic", label: "Bionic", icon: ScanLine },
  { id: "horizon", label: "Horizon", icon: ListChecks },
];

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function uiMorphReducer(state: UiMorphState, action: UiMorphAction): UiMorphState {
  switch (action.type) {
    case "set":
      return action.state;
    default:
      return state;
  }
}

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

function normalizeReadingToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}

function getBionicPrefixLength(word: string): number {
  const length = word.replace(/[^a-zA-Z0-9]/g, "").length;

  if (length <= 2) {
    return length;
  }

  if (length <= 5) {
    return 2;
  }

  if (length <= 8) {
    return 3;
  }

  return Math.max(3, Math.ceil(length * 0.42));
}

function BionicWord({ token, emphasized }: { token: string; emphasized: boolean }) {
  const match = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9'-]*)([^A-Za-z0-9]*)$/);

  if (!match) {
    return <span>{token}</span>;
  }

  const [, before, core, after] = match;
  const prefixLength = getBionicPrefixLength(core);
  const prefix = core.slice(0, prefixLength);
  const suffix = core.slice(prefixLength);

  return (
    <span className={cn("transition-colors", emphasized && "rounded-[4px] bg-[#ECECF7] px-0.5 text-[#35327D]")}>
      {before}
      <strong className="font-extrabold text-[#1F1F1D]">{prefix}</strong>
      <span className="font-normal">{suffix}</span>
      {after}
    </span>
  );
}

function BionicGuidedText({ text, terms }: { text: string; terms: string[] }) {
  const normalizedTerms = terms.map(normalizeReadingToken).filter(Boolean);
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];

  return (
    <>
      {sentences.map((sentence, sentenceIndex) => {
        let wordIndex = 0;

        return (
          <span key={`${sentence.slice(0, 18)}-${sentenceIndex}`}>
            {sentence.split(/(\s+)/).map((token, tokenIndex) => {
              if (/^\s+$/.test(token)) {
                return <span key={`${sentenceIndex}-space-${tokenIndex}`}>{token}</span>;
              }

              const normalizedToken = normalizeReadingToken(token);
              const isKeyword = normalizedTerms.some((term) => normalizedToken === term || normalizedToken.includes(term) || term.includes(normalizedToken));
              const isSentenceLead = wordIndex < 3;
              wordIndex += normalizedToken ? 1 : 0;

              return (
                <BionicWord
                  key={`${sentenceIndex}-${token}-${tokenIndex}`}
                  token={token}
                  emphasized={Boolean(normalizedToken && (isKeyword || isSentenceLead))}
                />
              );
            })}
          </span>
        );
      })}
    </>
  );
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
          <mark key={`${part}-${index}`} className="rounded-[4px] bg-[#ECECF7] px-1 py-0.5 text-[#35327D]">
            {part}
          </mark>
        );
      })}
    </>
  );
}

function buildHorizonFocusNodes(concepts: MissingConcept[], resources: VerifiedResource[]): HorizonFocusNode[] {
  return concepts
    .map((concept, index) => ({
      ...concept,
      index,
      resource: resources[index % Math.max(resources.length, 1)],
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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

function inferDocumentTitle(rawText: string): string {
  const firstLine = rawText
    .split(/\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "Untitled page";
  }

  return firstLine.replace(/^PaperLoom Chapter Scan:\s*/i, "").replace(/\s+and Learning Gaps$/i, "").trim();
}

function formatFingerprint(hash: string): string {
  return `${hash.slice(0, 8)} ... ${hash.slice(-4)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Recently scanned";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AppBrand() {
  return (
    <Link href="/" className="flex items-center gap-3 rounded-[8px] text-[#1F1F1D]">
      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-white">
        <FileText className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <span className="text-[15px] font-semibold">PaperLoom</span>
    </Link>
  );
}

function NavItem({
  icon: Icon,
  label,
  href,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-[8px] px-3 text-[13px] font-medium transition",
        active ? "bg-[#ECECF7] text-[#35327D]" : "text-[#6F6F6B] hover:bg-white hover:text-[#1F1F1D]",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
      <span>{label}</span>
    </Link>
  );
}

function StatusBadge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "success" | "accent" | "error" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "success" && "border-[#C9DECE] bg-[#F1F8F3] text-[#356B45]",
        tone === "accent" && "border-[#D8D7EF] bg-[#F1F0FA] text-[#42408A]",
        tone === "error" && "border-[#E9C7C7] bg-[#FEF2F2] text-[#9A3D3D]",
        tone === "neutral" && "border-[#E2E2DD] bg-[#F7F7F5] text-[#6F6F6B]",
      )}
    >
      {children}
    </span>
  );
}

function WorkspaceSidebar({ title, note }: { title?: string; note?: BookAndNote }) {
  return (
    <aside className="hidden min-h-screen border-r border-[#E8E8E4] bg-[#F2F2EF] px-4 py-5 lg:flex lg:w-[236px] lg:flex-col">
      <AppBrand />

      <nav className="mt-8 space-y-1">
        <NavItem icon={Home} label="Home" href="/" />
        <NavItem icon={FileText} label="Documents" href="/" />
        <NavItem icon={ScanLine} label="New scan" href="/#new-scan" />
      </nav>

      <div className="mt-8">
        <p className="px-3 text-xs font-medium text-[#92928E]">Current page</p>
        <div className="mt-2 rounded-[10px] border border-[#E1E1DC] bg-white px-3 py-3">
          <p className="line-clamp-3 text-sm font-semibold leading-5 text-[#1F1F1D]">{title ?? "Workspace"}</p>
          {note ? <p className="mt-2 font-mono text-xs text-[#6F6F6B]">{formatFingerprint(note.fingerprint_hash)}</p> : null}
        </div>
      </div>

      <div className="mt-auto space-y-3">
        <div className="rounded-[10px] border border-[#E1E1DC] bg-white px-3 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#1F1F1D]">
            <span className="h-2 w-2 rounded-full bg-[#4F8B62]" />
            Protected workspace
          </div>
          <p className="mt-1 text-xs leading-5 text-[#6F6F6B]">Access is tied to the page identity.</p>
        </div>
        <NavItem icon={Settings} label="Settings" href="/" />
      </div>
    </aside>
  );
}

function MobileTopBar() {
  return (
    <div className="sticky top-0 z-20 border-b border-[#E8E8E4] bg-[#F7F7F5]/95 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between">
        <AppBrand />
        <Link
          href="/"
          aria-label="Back to documents"
          className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-white text-[#1F1F1D] transition hover:bg-[#F2F2EF]"
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.8} />
        </Link>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <main className="min-h-screen bg-[#F7F7F5] text-[#1F1F1D]">
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
        <WorkspaceSidebar />
        <div className="min-w-0">
          <MobileTopBar />
          <div className="mx-auto max-w-[1220px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="h-32 animate-pulse rounded-[12px] border border-[#E8E8E4] bg-white" />
            <div className="mt-5 h-11 animate-pulse rounded-[10px] border border-[#E8E8E4] bg-white" />
            <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="h-[520px] animate-pulse rounded-[12px] border border-[#E8E8E4] bg-white" />
              <div className="h-[360px] animate-pulse rounded-[12px] border border-[#E8E8E4] bg-white" />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function EmptyState({ title, detail, tone = "neutral" }: { title: string; detail: string; tone?: "neutral" | "error" }) {
  return (
    <main className="min-h-screen bg-[#F7F7F5] text-[#1F1F1D]">
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
        <WorkspaceSidebar />
        <div className="min-w-0">
          <MobileTopBar />
          <div className="flex min-h-[calc(100vh-65px)] items-center justify-center px-4 py-10">
            <section className="w-full max-w-xl rounded-[12px] border border-[#E8E8E4] bg-white p-6 shadow-[0_18px_50px_rgba(31,31,29,0.06)]">
              <div
                className={cn(
                  "mb-5 flex h-10 w-10 items-center justify-center rounded-[10px]",
                  tone === "error" ? "bg-[#FEF2F2] text-[#9A3D3D]" : "bg-[#F1F0FA] text-[#42408A]",
                )}
              >
                <AlertCircle className="h-5 w-5" strokeWidth={1.8} />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-[#1F1F1D]">{title}</h1>
              <p className="mt-3 text-sm leading-6 text-[#6F6F6B]">{detail}</p>
              <Link
                href="/"
                className="mt-6 inline-flex h-9 items-center justify-center rounded-[8px] bg-[#4B4A8F] px-3.5 text-sm font-semibold text-white transition hover:bg-[#3F3E7B]"
              >
                Back to documents
              </Link>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function WorkspaceHeader({
  note,
  title,
  gapCount,
  resourceCount,
  copied,
  onCopyFingerprint,
}: {
  note: BookAndNote;
  title: string;
  gapCount: number;
  resourceCount: number;
  copied: boolean;
  onCopyFingerprint: () => void;
}) {
  return (
    <header className="rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)] sm:px-6">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm text-[#6F6F6B]">
            <Link href="/" className="font-medium text-[#4B4A8F]">
              Documents
            </Link>
            <ChevronRight className="h-4 w-4" strokeWidth={1.8} />
            <span className="min-w-0 truncate">{title}</span>
          </div>
          <h1 className="mt-3 max-w-4xl text-[30px] font-semibold leading-tight tracking-tight text-[#1F1F1D]">{title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#6F6F6B]">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-[#4B4A8F]" strokeWidth={1.8} />
              Verified page
            </span>
            <span>Last scanned {formatDate(note.created_at)}</span>
            <button
              type="button"
              onClick={onCopyFingerprint}
              className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 font-mono text-xs text-[#4B4A8F] transition hover:bg-[#F1F0FA]"
            >
              {copied ? <Check className="h-3.5 w-3.5" strokeWidth={1.8} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />}
              {formatFingerprint(note.fingerprint_hash)}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusBadge tone="accent">{gapCount} learning gaps</StatusBadge>
          <StatusBadge tone="success">{resourceCount} verified sources</StatusBadge>
        </div>
      </div>
    </header>
  );
}

function WorkspaceTabs({ activeTab, onChange }: { activeTab: WorkspaceTab; onChange: (tab: WorkspaceTab) => void }) {
  return (
    <div className="mt-5 overflow-x-auto rounded-[10px] border border-[#E8E8E4] bg-white p-1">
      <div className="flex min-w-max gap-1">
        {TAB_DEFINITIONS.map((tab) => {
          const Icon = tab.icon;
          const active = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-[8px] px-3 text-sm font-medium transition",
                active ? "bg-[#ECECF7] text-[#35327D]" : "text-[#6F6F6B] hover:bg-[#FAFAF8] hover:text-[#1F1F1D]",
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={1.8} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CognitiveControlPanel({
  uiMorphState,
  onChange,
}: {
  uiMorphState: UiMorphState;
  onChange: (state: UiMorphState) => void;
}) {
  return (
    <div
      className={cn(
        "sticky z-30 mb-5 rounded-[10px] border border-[#E8E8E4] bg-white/95 px-3 py-3 shadow-[0_14px_35px_rgba(31,31,29,0.05)] backdrop-blur",
        uiMorphState === "horizon" ? "top-4" : "top-[76px] lg:top-4",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-[#FAFAF8] text-[#4B4A8F]">
            <ScanLine className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1F1F1D]">Adaptive workspace</p>
            <p className="text-xs text-[#6F6F6B]">{UI_MORPH_OPTIONS.find((option) => option.id === uiMorphState)?.label ?? "Standard"} mode</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-[8px] bg-[#F2F2EF] p-1" role="radiogroup" aria-label="Workspace viewing profile">
          {UI_MORPH_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = option.id === uiMorphState;

            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={`${option.label} mode`}
                onClick={() => onChange(option.id)}
                className={cn(
                  "inline-flex h-9 min-w-[44px] items-center justify-center gap-2 rounded-[7px] px-3 text-sm font-medium transition",
                  active ? "bg-white text-[#35327D] shadow-[0_6px_18px_rgba(31,31,29,0.08)]" : "text-[#6F6F6B] hover:bg-white/70 hover:text-[#1F1F1D]",
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} />
                <span className="hidden sm:inline">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", SEVERITY_STYLES[severity])}>{SEVERITY_LABELS[severity]}</span>;
}

function LearningGapItem({
  concept,
  index,
  resource,
  expanded = false,
}: {
  concept: MissingConcept;
  index: number;
  resource?: VerifiedResource;
  expanded?: boolean;
}) {
  return (
    <article className="grid gap-4 border-b border-[#ECECE7] py-5 last:border-b-0 sm:grid-cols-[44px_minmax(0,1fr)]">
      <div className="font-mono text-sm text-[#92928E]">{String(index + 1).padStart(2, "0")}</div>
      <div className="min-w-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h3 className="text-base font-semibold text-[#1F1F1D]">{concept.title}</h3>
          <SeverityBadge severity={concept.severity} />
        </div>
        <p className="mt-2 text-sm leading-6 text-[#555550]">{concept.description}</p>

        {expanded ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-[#1F1F1D]">Why it matters</p>
              <p className="mt-1 text-sm leading-6 text-[#6F6F6B]">
                This gap can affect how the scanned explanation transfers to problems, examples, and follow-up study.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-[#1F1F1D]">Verified source</p>
              {resource ? (
                <a
                  href={resource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-start gap-2 text-sm leading-6 text-[#4B4A8F]"
                >
                  <span>{resource.title}</span>
                  <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                </a>
              ) : (
                <p className="mt-1 text-sm leading-6 text-[#6F6F6B]">A source will appear when validation includes a matching reference.</p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SourceRow({ resource, index }: { resource: VerifiedResource; index: number }) {
  const hostname = resource.source_domain ?? safeHostname(resource.url);

  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noreferrer"
      className="grid gap-3 border-b border-[#ECECE7] px-4 py-4 transition last:border-b-0 hover:bg-[#FAFAF8] sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center sm:px-5"
    >
      <span className="font-mono text-sm text-[#92928E]">[{String(index + 1).padStart(2, "0")}]</span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[#1F1F1D]">{resource.title}</p>
        <p className="mt-1 text-xs text-[#6F6F6B]">{hostname}</p>
        {resource.supports ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#6F6F6B]">{resource.supports}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        <StatusBadge tone="success">Verified educational source</StatusBadge>
        <ExternalLink className="h-4 w-4 text-[#92928E]" strokeWidth={1.8} />
      </div>
    </a>
  );
}

function PageIdentityPanel({ note, copied, onCopyFingerprint }: { note: BookAndNote; copied: boolean; onCopyFingerprint: () => void }) {
  return (
    <aside className="h-fit rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#1F1F1D]">Page identity</h2>
          <p className="mt-1 text-sm leading-6 text-[#6F6F6B]">This workspace is opened from the page fingerprint.</p>
        </div>
        <StatusBadge tone="success">Verified</StatusBadge>
      </div>

      <dl className="mt-5 space-y-4 text-sm">
        <div>
          <dt className="text-xs font-medium text-[#92928E]">Fingerprint</dt>
          <dd className="mt-1 flex items-center justify-between gap-3 rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] px-3 py-2">
            <code className="min-w-0 truncate font-mono text-xs text-[#4B4A8F]">{formatFingerprint(note.fingerprint_hash)}</code>
            <button
              type="button"
              onClick={onCopyFingerprint}
              aria-label="Copy page fingerprint"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[#6F6F6B] transition hover:bg-white hover:text-[#1F1F1D]"
            >
              {copied ? <Check className="h-4 w-4" strokeWidth={1.8} /> : <Copy className="h-4 w-4" strokeWidth={1.8} />}
            </button>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-[#92928E]">Scan date</dt>
          <dd className="mt-1 text-[#1F1F1D]">{formatDate(note.created_at)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-[#92928E]">Device</dt>
          <dd className="mt-1 text-[#1F1F1D]">paperloom-browser-console-001</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-[#92928E]">Verification status</dt>
          <dd className="mt-1 text-[#1F1F1D]">Page identity verified</dd>
        </div>
      </dl>
    </aside>
  );
}

function HorizonFocusLayout({
  nodes,
  activeIndex,
  onPrevious,
  onNext,
}: {
  nodes: HorizonFocusNode[];
  activeIndex: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const node = nodes[activeIndex] ?? null;
  const hasMultipleNodes = nodes.length > 1;
  const resource = node?.resource;

  return (
    <section className="mt-6 flex min-h-[calc(100vh-158px)] items-center justify-center bg-white px-2 py-8 sm:px-4">
      <article className="w-full max-w-2xl rounded-[12px] border border-[#E8E8E4] bg-white p-5 shadow-[0_24px_70px_rgba(31,31,29,0.08)] sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-xs text-[#92928E]">
              {node ? `Node ${String(activeIndex + 1).padStart(2, "0")}` : "Node 01"}
            </p>
            <h1 className="mt-2 text-[26px] font-semibold leading-tight text-[#1F1F1D]">
              {node?.title ?? "No learning gap recorded"}
            </h1>
          </div>
          {node ? <SeverityBadge severity={node.severity} /> : <StatusBadge tone="success">Clear</StatusBadge>}
        </div>

        <p className="mt-5 text-base leading-8 text-[#3D3D39]">
          {node?.description ?? "This scan does not currently include a missing concept. Keep the workspace in standard mode for full page review."}
        </p>

        {resource ? (
          <div className="mt-6 border-t border-[#ECECE7] pt-4">
            <p className="text-xs font-semibold text-[#1F1F1D]">Verified source</p>
            <a
              href={resource.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-start gap-2 text-sm leading-6 text-[#4B4A8F]"
            >
              <span>{resource.title}</span>
              <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            </a>
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 border-t border-[#ECECE7] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-[#6F6F6B]">
            {nodes.length > 0 ? `${activeIndex + 1} of ${nodes.length}` : "1 of 1"}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPrevious}
              disabled={!hasMultipleNodes}
              aria-label="Previous focus node"
              className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-white text-[#6F6F6B] transition hover:bg-[#FAFAF8] hover:text-[#1F1F1D] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4 rotate-180" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!hasMultipleNodes}
              aria-label="Next focus node"
              className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-white text-[#6F6F6B] transition hover:bg-[#FAFAF8] hover:text-[#1F1F1D] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </article>
    </section>
  );
}

function OverviewTab({
  note,
  concepts,
  resources,
  copied,
  onCopyFingerprint,
}: {
  note: BookAndNote;
  concepts: MissingConcept[];
  resources: VerifiedResource[];
  copied: boolean;
  onCopyFingerprint: () => void;
}) {
  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)] sm:px-6">
        <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">Analysis</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6F6F6B]">
          PaperLoom found {concepts.length} {concepts.length === 1 ? "concept" : "concepts"} that may need additional review.
        </p>

        <div className="mt-4">
          {concepts.length === 0 ? (
            <div className="rounded-[10px] border border-[#C9DECE] bg-[#F1F8F3] p-4 text-sm leading-6 text-[#356B45]">
              No missing concepts were recorded for this scan yet.
            </div>
          ) : (
            concepts.map((concept, index) => (
              <LearningGapItem key={`${concept.severity}-${concept.title}`} concept={concept} index={index} resource={resources[index]} />
            ))
          )}
        </div>
      </section>

      <div className="space-y-5">
        <PageIdentityPanel note={note} copied={copied} onCopyFingerprint={onCopyFingerprint} />
        <section className="rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)]">
          <h2 className="text-base font-semibold text-[#1F1F1D]">Verified sources</h2>
          <div className="mt-3 space-y-3">
            {resources.slice(0, 3).map((resource, index) => (
              <a
                key={`${resource.url}-${index}`}
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="block rounded-[8px] border border-[#E8E8E4] px-3 py-3 transition hover:bg-[#FAFAF8]"
              >
                <p className="line-clamp-2 text-sm font-semibold leading-5 text-[#1F1F1D]">{resource.title}</p>
                <p className="mt-1 text-xs text-[#6F6F6B]">{resource.source_domain ?? safeHostname(resource.url)}</p>
              </a>
            ))}
            {resources.length === 0 ? <p className="text-sm leading-6 text-[#6F6F6B]">Sources will appear when validation returns references.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function PageCanvas({
  note,
  concepts,
  uiMorphState,
}: {
  note: BookAndNote;
  concepts: MissingConcept[];
  uiMorphState: UiMorphState;
}) {
  const paragraphs = useMemo(() => splitIntoParagraphs(note.raw_text), [note.raw_text]);
  const highlightTerms = useMemo(() => buildHighlightTerms(concepts), [concepts]);
  const title = inferDocumentTitle(note.raw_text);
  const isBionic = uiMorphState === "bionic";

  return (
    <div
      className={cn(
        "rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_18px_55px_rgba(31,31,29,0.08)] transition-all duration-300 sm:px-8 sm:py-7",
        isBionic && "border-[#D8D7EF] bg-[#FEFEFC]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#ECECE7] pb-4 text-xs text-[#6F6F6B]">
        <span>Page scan</span>
        <span>/</span>
        <span>{paragraphs.length} sections</span>
        <span>/</span>
        <span>{isBionic ? "Bionic spatial view" : "Verified page"}</span>
      </div>
      <article className="paperloom-scrollbar mt-6 max-h-[760px] overflow-y-auto pr-1">
        <h2 className={cn("max-w-2xl text-[24px] font-semibold leading-tight text-[#1F1F1D]", isBionic ? "tracking-wide" : "tracking-tight")}>
          {title}
        </h2>
        <div className={cn("mt-6 space-y-4 text-[15px] text-[#33332F]", isBionic ? "leading-loose tracking-wide" : "leading-7")}>
          {paragraphs.slice(1).map((paragraph, index) => {
            const severity = getParagraphSeverity(paragraph, concepts);

            return (
              <p
                key={`${paragraph.slice(0, 18)}-${index}`}
                className={cn(
                  "rounded-[8px] border-l-2 py-1 pl-3 transition-all duration-300",
                  isBionic && "py-2 pl-4 leading-loose tracking-wide",
                  severity === "critical" && "border-l-[#C96D6D]",
                  severity === "high" && "border-l-[#C98264]",
                  severity === "medium" && "border-l-[#BCA35F]",
                  severity === "low" && "border-l-[#6FA77C]",
                  !severity && "border-l-transparent",
                )}
              >
                {isBionic ? <BionicGuidedText text={paragraph} terms={highlightTerms} /> : <HighlightedText text={paragraph} terms={highlightTerms} />}
              </p>
            );
          })}
        </div>
      </article>
    </div>
  );
}

function PageTab({
  note,
  concepts,
  copied,
  onCopyFingerprint,
  uiMorphState,
}: {
  note: BookAndNote;
  concepts: MissingConcept[];
  copied: boolean;
  onCopyFingerprint: () => void;
  uiMorphState: UiMorphState;
}) {
  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <PageCanvas note={note} concepts={concepts} uiMorphState={uiMorphState} />
      <PageIdentityPanel note={note} copied={copied} onCopyFingerprint={onCopyFingerprint} />
    </div>
  );
}

function LearningGapsTab({ concepts, resources }: { concepts: MissingConcept[]; resources: VerifiedResource[] }) {
  return (
    <section className="mt-6 rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)] sm:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">Learning gaps</h2>
          <p className="mt-2 text-sm leading-6 text-[#6F6F6B]">Annotations connected to the scanned document.</p>
        </div>
        <StatusBadge tone="accent">{concepts.length} total</StatusBadge>
      </div>

      <div className="mt-4">
        {concepts.length === 0 ? (
          <div className="rounded-[10px] border border-[#C9DECE] bg-[#F1F8F3] p-4 text-sm leading-6 text-[#356B45]">
            No missing concepts were recorded for this scan yet.
          </div>
        ) : (
          concepts.map((concept, index) => (
            <LearningGapItem
              key={`${concept.severity}-${concept.title}`}
              concept={concept}
              index={index}
              resource={resources[index % Math.max(resources.length, 1)]}
              expanded
            />
          ))
        )}
      </div>
    </section>
  );
}

function SourcesTab({ resources }: { resources: VerifiedResource[] }) {
  return (
    <section className="mt-6 overflow-hidden rounded-[12px] border border-[#E8E8E4] bg-white shadow-[0_14px_35px_rgba(31,31,29,0.04)]">
      <div className="border-b border-[#ECECE7] px-5 py-5">
        <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">Sources</h2>
        <p className="mt-2 text-sm leading-6 text-[#6F6F6B]">Research bibliography used to support the analysis.</p>
      </div>

      {resources.length === 0 ? (
        <div className="p-5 text-sm leading-6 text-[#6F6F6B]">Sources will appear when validation returns references.</div>
      ) : (
        resources.map((resource, index) => <SourceRow key={`${resource.url}-${index}`} resource={resource} index={index} />)
      )}
    </section>
  );
}

function PracticeTab({
  questions,
  answers,
  setAnswers,
}: {
  questions: QuizQuestion[];
  answers: Record<string, number>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  const answeredCount = Object.keys(answers).length;
  const correctCount = questions.filter((question) => answers[question.id] === question.correctIndex).length;
  const scorePercent = questions.length === 0 ? 0 : Math.round((correctCount / questions.length) * 100);

  return (
    <section className="mt-6 rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.04)] sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">Practice</h2>
          <p className="mt-2 text-sm leading-6 text-[#6F6F6B]">A short check built from the learning gaps.</p>
        </div>
        <StatusBadge tone="accent">
          {answeredCount} of {questions.length} answered / {scorePercent}% correct
        </StatusBadge>
      </div>

      <div className="mt-5 space-y-5">
        {questions.length === 0 ? (
          <div className="rounded-[10px] border border-[#E8E8E4] bg-[#FAFAF8] p-4 text-sm leading-6 text-[#6F6F6B]">
            Practice questions will appear once the audit contains learning gaps.
          </div>
        ) : (
          questions.map((question, index) => {
            const selected = answers[question.id];
            const hasAnswered = selected !== undefined;

            return (
              <article key={question.id} className="border-b border-[#ECECE7] pb-5 last:border-b-0 last:pb-0">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-mono text-xs text-[#92928E]">Question {index + 1}</p>
                    <h3 className="mt-2 text-sm font-semibold leading-6 text-[#1F1F1D]">{question.question}</h3>
                  </div>
                  <SeverityBadge severity={question.severity} />
                </div>

                <div className="mt-3 grid gap-2">
                  {question.options.map((option, optionIndex) => {
                    const isSelected = selected === optionIndex;
                    const isCorrect = question.correctIndex === optionIndex;
                    const stateClass =
                      hasAnswered && isCorrect
                        ? "border-[#C9DECE] bg-[#F1F8F3] text-[#244E30]"
                        : hasAnswered && isSelected && !isCorrect
                          ? "border-[#E9C7C7] bg-[#FEF2F2] text-[#9A3D3D]"
                          : isSelected
                            ? "border-[#D8D7EF] bg-[#F1F0FA] text-[#35327D]"
                            : "border-[#E8E8E4] bg-white text-[#555550] hover:bg-[#FAFAF8]";

                    return (
                      <button
                        key={`${question.id}-${optionIndex}`}
                        type="button"
                        onClick={() => setAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                        className={cn("w-full rounded-[8px] border px-3 py-3 text-left text-sm leading-6 transition", stateClass)}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>

                {hasAnswered ? (
                  <div className="mt-3 rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] p-3 text-sm leading-6 text-[#6F6F6B]">
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
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [uiMorphState, dispatchUiMorphState] = useReducer(uiMorphReducer, "standard");
  const [horizonIndex, setHorizonIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});

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

  const concepts = useMemo(() => workspace?.gaps?.missing_concepts ?? [], [workspace?.gaps?.missing_concepts]);
  const resources = useMemo(() => workspace?.gaps?.verified_resources ?? [], [workspace?.gaps?.verified_resources]);
  const horizonNodes = useMemo(() => buildHorizonFocusNodes(concepts, resources), [concepts, resources]);
  const quizQuestions = useMemo(() => generateQuizQuestions(concepts, resources), [concepts, resources]);
  const title = useMemo(() => (workspace?.note ? inferDocumentTitle(workspace.note.raw_text) : "Workspace"), [workspace?.note]);

  useEffect(() => {
    setHorizonIndex((current) => {
      if (horizonNodes.length === 0) {
        return 0;
      }

      return Math.min(current, horizonNodes.length - 1);
    });
  }, [horizonNodes.length]);

  async function handleCopyFingerprint() {
    const fingerprint = workspace?.note?.fingerprint_hash;

    if (!fingerprint || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function handleUiMorphStateChange(nextState: UiMorphState) {
    dispatchUiMorphState({ type: "set", state: nextState });

    if (nextState === "bionic") {
      setActiveTab("page");
    }
  }

  function handlePreviousHorizonNode() {
    setHorizonIndex((current) => {
      if (horizonNodes.length <= 1) {
        return current;
      }

      return (current - 1 + horizonNodes.length) % horizonNodes.length;
    });
  }

  function handleNextHorizonNode() {
    setHorizonIndex((current) => {
      if (horizonNodes.length <= 1) {
        return current;
      }

      return (current + 1) % horizonNodes.length;
    });
  }

  if (state === "idle" || state === "loading") {
    return <DashboardSkeleton />;
  }

  if (state === "missing-token") {
    return (
      <EmptyState
        title="Workspace access required"
        detail="Open this workspace from the scan result so PaperLoom can verify the page token for this fingerprint."
      />
    );
  }

  if (state === "not-found") {
    return (
      <EmptyState
        title="Workspace not found"
        detail="No authorized page exists for this fingerprint, or the current token does not match this document."
        tone="error"
      />
    );
  }

  if (state === "error" || !workspace || !workspace.note) {
    return (
      <EmptyState
        title="Workspace unavailable"
        detail={error ?? "The document workspace could not be loaded."}
        tone="error"
      />
    );
  }

  const isHorizon = uiMorphState === "horizon";

  return (
    <main className={cn("min-h-screen text-[#1F1F1D]", isHorizon ? "bg-white" : "bg-[#F7F7F5]")}>
      <div className={cn(!isHorizon && "lg:grid lg:grid-cols-[236px_minmax(0,1fr)]")}>
        {!isHorizon ? <WorkspaceSidebar title={title} note={workspace.note} /> : null}
        <div className="min-w-0">
          {!isHorizon ? <MobileTopBar /> : null}
          <div className={cn("mx-auto max-w-[1220px] px-4 sm:px-6 lg:px-8", isHorizon ? "py-4 lg:py-5" : "py-6 lg:py-8")}>
            <CognitiveControlPanel uiMorphState={uiMorphState} onChange={handleUiMorphStateChange} />

            {isHorizon ? (
              <HorizonFocusLayout
                nodes={horizonNodes}
                activeIndex={horizonIndex}
                onPrevious={handlePreviousHorizonNode}
                onNext={handleNextHorizonNode}
              />
            ) : (
              <>
                <WorkspaceHeader
                  note={workspace.note}
                  title={title}
                  gapCount={concepts.length}
                  resourceCount={resources.length}
                  copied={copied}
                  onCopyFingerprint={handleCopyFingerprint}
                />

                <WorkspaceTabs activeTab={activeTab} onChange={setActiveTab} />

                {activeTab === "overview" ? (
                  <OverviewTab
                    note={workspace.note}
                    concepts={concepts}
                    resources={resources}
                    copied={copied}
                    onCopyFingerprint={handleCopyFingerprint}
                  />
                ) : null}
                {activeTab === "page" ? (
                  <PageTab
                    note={workspace.note}
                    concepts={concepts}
                    copied={copied}
                    onCopyFingerprint={handleCopyFingerprint}
                    uiMorphState={uiMorphState}
                  />
                ) : null}
                {activeTab === "gaps" ? <LearningGapsTab concepts={concepts} resources={resources} /> : null}
                {activeTab === "sources" ? <SourcesTab resources={resources} /> : null}
                {activeTab === "practice" ? <PracticeTab questions={quizQuestions} answers={answers} setAnswers={setAnswers} /> : null}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
