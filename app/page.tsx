"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  Circle,
  Copy,
  ExternalLink,
  FileText,
  Home,
  PanelLeft,
  Plus,
  ScanLine,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

type IngestResponse =
  | {
      success: true;
      id: string;
      token: string;
      dashboard_path?: string;
      educational_gap_id: string;
      missing_concepts_count: number;
      verified_resources_count: number;
      render_workspace?: {
        serviceId: string;
        serviceName: string;
        serviceUrl: string | null;
        deployId: string | null;
      } | null;
    }
  | {
      success: false;
      error: string;
      details?: unknown;
    };

type ScanStage = "idle" | "reading" | "fingerprinting" | "verifying" | "analyzing" | "creating" | "complete" | "error";

type TextStats = {
  words: number;
  paragraphs: number;
  characters: number;
};

type DocumentListItem = {
  title: string;
  scannedAt: string;
  status: string;
  gapCount: number | null;
  href?: string;
  isActive?: boolean;
};

const SAMPLE_TEXT = `PaperLoom Chapter Scan: Foundations of Electromagnetism and Learning Gaps

Electric charge is a conserved property of matter. Opposite charges attract, like charges repel, and the force between two point charges is proportional to the product of their charges and inversely proportional to the square of the distance between them. This relationship is described by Coulomb's law.

An electric field represents the force that a positive test charge would experience at a point in space. Field lines begin on positive charges and terminate on negative charges. The density of field lines indicates the relative strength of the electric field.

Electric potential energy changes when a charge moves through an electric field. Electric potential, measured in volts, is potential energy per unit charge. A battery creates a potential difference that can drive current through a closed circuit.

Current is the rate of flow of electric charge. Resistance measures how strongly a material opposes current. Ohm's law states that voltage equals current multiplied by resistance. In series circuits, resistances add directly. In parallel circuits, the reciprocal of the equivalent resistance equals the sum of the reciprocals of each branch resistance.

Magnetic fields are produced by moving charges and by changing electric fields. A current-carrying wire generates circular magnetic field lines around the wire. The right-hand rule gives the direction of the magnetic field. A charged particle moving through a magnetic field experiences a force perpendicular to both its velocity and the field.

Electromagnetic induction occurs when a changing magnetic flux produces an electromotive force. Faraday's law relates induced voltage to the rate of change of magnetic flux. Lenz's law states that the induced current opposes the change that created it.

Likely student gaps:
1. Distinguishing electric field from electric potential.
2. Understanding why equivalent resistance decreases in parallel circuits.
3. Applying the right-hand rule consistently.
4. Connecting magnetic flux changes to induced current direction.`;

const SCAN_STEPS: Array<{ id: Exclude<ScanStage, "idle" | "complete" | "error">; label: string }> = [
  { id: "reading", label: "Reading page" },
  { id: "fingerprinting", label: "Generating page fingerprint" },
  { id: "verifying", label: "Verifying document identity" },
  { id: "analyzing", label: "Analyzing learning gaps" },
  { id: "creating", label: "Creating workspace" },
];

const STAGE_ORDER: Record<Exclude<ScanStage, "idle" | "complete" | "error">, number> = {
  reading: 0,
  fingerprinting: 1,
  verifying: 2,
  analyzing: 3,
  creating: 4,
};

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(digest);
}

function makePseudoFiberPayload(rawText: string): string {
  const stableNoise = rawText
    .split("")
    .slice(0, 512)
    .map((char, index) => `${char.charCodeAt(0) ^ ((index * 31) % 251)}`)
    .join(":");

  return `paperloom-v1|stroke-pressure|fiber-variance|${stableNoise}|${rawText.length}`;
}

function storePaperLoomToken(token: string): void {
  sessionStorage.setItem("paperloom.jwt", token);
  sessionStorage.setItem("paperloom_token", token);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
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

function formatFingerprint(hash: string | null): string {
  if (!hash) {
    return "Generated when the page is connected";
  }

  return `${hash.slice(0, 8)} ... ${hash.slice(-4)}`;
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
    <a
      href={href}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-[8px] px-3 text-[13px] font-medium transition",
        active ? "bg-[#ECECF7] text-[#35327D]" : "text-[#6F6F6B] hover:bg-white hover:text-[#1F1F1D]",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
      <span>{label}</span>
    </a>
  );
}

function AppSidebar({ recentDocuments }: { recentDocuments: DocumentListItem[] }) {
  return (
    <aside className="hidden min-h-screen border-r border-[#E8E8E4] bg-[#F2F2EF] px-4 py-5 lg:flex lg:w-[236px] lg:flex-col">
      <AppBrand />

      <nav className="mt-8 space-y-1">
        <NavItem icon={Home} label="Home" href="#documents" active />
        <NavItem icon={FileText} label="Documents" href="#documents" />
        <NavItem icon={ScanLine} label="New scan" href="#new-scan" />
      </nav>

      <div className="mt-8">
        <p className="px-3 text-xs font-medium text-[#92928E]">Recent</p>
        <div className="mt-2 space-y-1">
          {recentDocuments.slice(0, 3).map((document) => (
            <a
              key={`${document.title}-${document.scannedAt}`}
              href={document.href ?? "#new-scan"}
              className="group flex items-start gap-2 rounded-[8px] px-3 py-2 text-left text-[13px] leading-5 text-[#6F6F6B] transition hover:bg-white hover:text-[#1F1F1D]"
            >
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
              <span className="line-clamp-2">{document.title}</span>
            </a>
          ))}
        </div>
      </div>

      <div className="mt-auto space-y-3">
        <div className="rounded-[10px] border border-[#E1E1DC] bg-white px-3 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#1F1F1D]">
            <span className="h-2 w-2 rounded-full bg-[#4F8B62]" />
            Device connected
          </div>
          <p className="mt-1 break-all text-xs leading-5 text-[#6F6F6B]">paperloom-browser-console-001</p>
        </div>
        <NavItem icon={Settings} label="Settings" href="#settings" />
      </div>
    </aside>
  );
}

function MobileTopBar() {
  return (
    <div className="sticky top-0 z-20 border-b border-[#E8E8E4] bg-[#F7F7F5]/95 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between">
        <AppBrand />
        <a
          href="#new-scan"
          aria-label="Open new scan"
          className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-[#DDDDD8] bg-white text-[#1F1F1D] transition hover:bg-[#F2F2EF]"
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.8} />
        </a>
      </div>
    </div>
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

function DocumentRow({ document }: { document: DocumentListItem }) {
  const content = (
    <div className="grid min-h-[72px] grid-cols-[1fr_auto] items-center gap-4 border-b border-[#ECECE7] px-4 py-3 last:border-b-0 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-[#E8E8E4] bg-[#FBFBFA] text-[#6F6F6B]">
          <FileText className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#1F1F1D]">{document.title}</p>
          <p className="mt-1 text-xs text-[#6F6F6B]">{document.scannedAt}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden text-right text-xs text-[#6F6F6B] sm:block">
          <p>{document.gapCount === null ? "No gaps yet" : `${document.gapCount} gaps`}</p>
          <p className="mt-1">{document.status}</p>
        </div>
        <StatusBadge tone={document.isActive ? "success" : "neutral"}>{document.status}</StatusBadge>
        <ChevronRight className="hidden h-4 w-4 text-[#92928E] sm:block" strokeWidth={1.8} />
      </div>
    </div>
  );

  if (!document.href) {
    return content;
  }

  return (
    <Link href={document.href} className="block transition hover:bg-[#FAFAF8]">
      {content}
    </Link>
  );
}

function DocumentsPanel({ documents }: { documents: DocumentListItem[] }) {
  return (
    <section id="documents" className="scroll-mt-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight text-[#1F1F1D]">Documents</h1>
          <p className="mt-1 text-sm text-[#6F6F6B]">Pages connected to PaperLoom</p>
        </div>
        <a
          href="#new-scan"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-[8px] bg-[#4B4A8F] px-3.5 text-sm font-semibold text-white transition hover:bg-[#3F3E7B] focus:outline-none focus:ring-2 focus:ring-[#4B4A8F]/25"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
          New scan
        </a>
      </div>

      <div className="mt-5 overflow-hidden rounded-[12px] border border-[#E8E8E4] bg-white">
        {documents.map((document) => (
          <DocumentRow key={`${document.title}-${document.scannedAt}-${document.status}`} document={document} />
        ))}
      </div>
    </section>
  );
}

function PagePreview({ rawText, stats, deviceId }: { rawText: string; stats: TextStats; deviceId: string }) {
  const paragraphs = splitIntoParagraphs(rawText);
  const title = inferDocumentTitle(rawText);

  return (
    <section className="min-w-0">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">Page preview</h2>
          <p className="mt-1 text-sm text-[#6F6F6B]">Extracted text from the connected page.</p>
        </div>
        <StatusBadge tone="success">Device connected</StatusBadge>
      </div>

      <div className="mx-auto w-full max-w-[760px] rounded-[10px] border border-[#E2E2DD] bg-white px-5 py-5 shadow-[0_18px_55px_rgba(31,31,29,0.08)] sm:px-8 sm:py-7">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#ECECE7] pb-4 text-xs text-[#6F6F6B]">
          <span>Page scan</span>
          <span>/</span>
          <span>{stats.words} words</span>
          <span>/</span>
          <span className="max-w-full truncate">{deviceId}</span>
        </div>
        <article className="paperloom-scrollbar mt-6 max-h-[640px] overflow-y-auto pr-1">
          <h3 className="max-w-2xl text-[24px] font-semibold leading-tight tracking-tight text-[#1F1F1D]">{title}</h3>
          <div className="mt-6 space-y-4 text-[15px] leading-7 text-[#33332F]">
            {paragraphs.slice(1).map((paragraph, index) => (
              <p key={`${paragraph.slice(0, 18)}-${index}`}>{paragraph}</p>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

function PageIdentity({
  fingerprintHash,
  copied,
  onCopy,
}: {
  fingerprintHash: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-3 border-t border-[#E8E8E4] pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#1F1F1D]">Page identity</p>
          <p className="mt-1 text-xs leading-5 text-[#6F6F6B]">
            {fingerprintHash ? "Verified for this page." : "Fingerprint will be generated when the page is connected."}
          </p>
        </div>
        {fingerprintHash ? <StatusBadge tone="success">Verified</StatusBadge> : <StatusBadge>Pending</StatusBadge>}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] px-3 py-2">
        <code className="min-w-0 truncate font-mono text-xs text-[#4B4A8F]">{formatFingerprint(fingerprintHash)}</code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!fingerprintHash}
          aria-label="Copy page fingerprint"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[#6F6F6B] transition hover:bg-white hover:text-[#1F1F1D] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check className="h-4 w-4" strokeWidth={1.8} /> : <Copy className="h-4 w-4" strokeWidth={1.8} />}
        </button>
      </div>

      {fingerprintHash ? (
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-[#4B4A8F] outline-none">View full fingerprint</summary>
          <p className="mt-2 break-all rounded-[8px] border border-[#E8E8E4] bg-white p-3 font-mono text-xs leading-5 text-[#6F6F6B]">
            {fingerprintHash}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function ScanProgress({ stage }: { stage: ScanStage }) {
  const activeIndex =
    stage === "complete" ? SCAN_STEPS.length : stage === "idle" || stage === "error" ? -1 : STAGE_ORDER[stage];

  return (
    <div className="space-y-3 border-t border-[#E8E8E4] pt-5">
      <p className="text-sm font-semibold text-[#1F1F1D]">Process</p>
      <div className="space-y-3">
        {SCAN_STEPS.map((step, index) => {
          const isDone = stage === "complete" || index < activeIndex;
          const isActive = index === activeIndex && stage !== "complete";

          return (
            <div key={step.id} className="flex items-center gap-3 text-sm">
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition",
                  isDone && "border-[#4F8B62] bg-[#4F8B62] text-white",
                  isActive && "border-[#4B4A8F] bg-white text-[#4B4A8F]",
                  !isDone && !isActive && "border-[#D6D6D0] bg-white text-[#92928E]",
                )}
              >
                {isDone ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                ) : (
                  <Circle className={cn("h-2 w-2", isActive && "fill-current")} strokeWidth={1.8} />
                )}
              </span>
              <span className={cn("transition", isActive || isDone ? "text-[#1F1F1D]" : "text-[#92928E]")}>{step.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScanSuccess({
  result,
  dashboardHref,
}: {
  result: Extract<IngestResponse, { success: true }>;
  dashboardHref: string;
}) {
  return (
    <div className="space-y-4 border-t border-[#E8E8E4] pt-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#F1F8F3] text-[#356B45]">
          <Check className="h-4 w-4" strokeWidth={2} />
        </span>
        <div>
          <p className="text-base font-semibold text-[#1F1F1D]">Workspace ready</p>
          <p className="mt-1 text-sm leading-6 text-[#6F6F6B]">Your page has been verified and analyzed.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] px-2 py-3">
          <p className="text-lg font-semibold text-[#1F1F1D]">{result.missing_concepts_count}</p>
          <p className="mt-1 text-[11px] text-[#6F6F6B]">Learning gaps</p>
        </div>
        <div className="rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] px-2 py-3">
          <p className="text-lg font-semibold text-[#1F1F1D]">{result.verified_resources_count}</p>
          <p className="mt-1 text-[11px] text-[#6F6F6B]">Resources</p>
        </div>
        <div className="rounded-[8px] border border-[#E8E8E4] bg-[#FAFAF8] px-2 py-3">
          <p className="text-lg font-semibold text-[#1F1F1D]">Yes</p>
          <p className="mt-1 text-[11px] text-[#6F6F6B]">Verified</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link
          href={dashboardHref}
          className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[8px] bg-[#4B4A8F] px-3.5 text-sm font-semibold text-white transition hover:bg-[#3F3E7B] focus:outline-none focus:ring-2 focus:ring-[#4B4A8F]/25"
        >
          Open workspace
          <ChevronRight className="h-4 w-4" strokeWidth={1.8} />
        </Link>
        <a
          href="#new-scan"
          className="inline-flex h-9 flex-1 items-center justify-center rounded-[8px] border border-[#DCDCD6] bg-white px-3.5 text-sm font-semibold text-[#1F1F1D] transition hover:bg-[#F7F7F5]"
        >
          Scan another page
        </a>
      </div>

      {result.render_workspace?.serviceUrl ? (
        <a
          href={result.render_workspace.serviceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-sm font-medium text-[#4B4A8F]"
        >
          Render instance
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
        </a>
      ) : null}
    </div>
  );
}

function ScanPanel({
  deviceId,
  setDeviceId,
  rawText,
  setRawText,
  stats,
  fingerprintHash,
  isSubmitting,
  stage,
  result,
  error,
  isEditorOpen,
  setIsEditorOpen,
  copied,
  onCopyFingerprint,
  onSubmit,
}: {
  deviceId: string;
  setDeviceId: (value: string) => void;
  rawText: string;
  setRawText: (value: string) => void;
  stats: TextStats;
  fingerprintHash: string | null;
  isSubmitting: boolean;
  stage: ScanStage;
  result: Extract<IngestResponse, { success: true }> | null;
  error: string | null;
  isEditorOpen: boolean;
  setIsEditorOpen: (value: boolean) => void;
  copied: boolean;
  onCopyFingerprint: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dashboardHref = result?.dashboard_path ?? `/dashboard/${fingerprintHash}`;

  return (
    <form
      onSubmit={onSubmit}
      className="h-fit rounded-[12px] border border-[#E8E8E4] bg-white px-5 py-5 shadow-[0_14px_35px_rgba(31,31,29,0.05)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#1F1F1D]">New scan</h2>
          <p className="mt-1 text-sm leading-6 text-[#6F6F6B]">Connect a physical page to its PaperLoom workspace.</p>
        </div>
        <ScanLine className="h-5 w-5 shrink-0 text-[#4B4A8F]" strokeWidth={1.8} />
      </div>

      <div className="mt-6 space-y-5">
        <label className="block">
          <span className="text-sm font-semibold text-[#1F1F1D]">Device</span>
          <input
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            className="mt-2 h-10 w-full rounded-[8px] border border-[#DCDCD6] bg-white px-3 text-sm text-[#1F1F1D] outline-none transition placeholder:text-[#92928E] focus:border-[#4B4A8F] focus:ring-2 focus:ring-[#4B4A8F]/15"
            minLength={1}
            maxLength={128}
            required
          />
        </label>

        <div className="space-y-3 border-t border-[#E8E8E4] pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[#1F1F1D]">Extracted text</p>
              <p className="mt-1 text-xs leading-5 text-[#6F6F6B]">
                {stats.words} words / {stats.paragraphs} sections / {stats.characters} characters
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsEditorOpen(!isEditorOpen)}
              className="rounded-[8px] px-2.5 py-1.5 text-xs font-semibold text-[#4B4A8F] transition hover:bg-[#F1F0FA]"
            >
              {isEditorOpen ? "Close editor" : "Edit extracted text"}
            </button>
          </div>

          {isEditorOpen ? (
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              className="paperloom-scrollbar min-h-[300px] w-full rounded-[10px] border border-[#DCDCD6] bg-[#FAFAF8] px-3 py-3 font-mono text-xs leading-6 text-[#1F1F1D] outline-none transition focus:border-[#4B4A8F] focus:ring-2 focus:ring-[#4B4A8F]/15"
              minLength={16}
              maxLength={500000}
              required
            />
          ) : null}
        </div>

        <PageIdentity fingerprintHash={fingerprintHash} copied={copied} onCopy={onCopyFingerprint} />

        {isSubmitting || stage === "complete" ? <ScanProgress stage={stage} /> : null}

        {result ? <ScanSuccess result={result} dashboardHref={dashboardHref} /> : null}

        {error ? (
          <div className="rounded-[10px] border border-[#E9C7C7] bg-[#FEF2F2] p-3 text-sm leading-6 text-[#9A3D3D]">{error}</div>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-[#E8E8E4] pt-5 sm:flex-row">
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[8px] bg-[#4B4A8F] px-4 text-sm font-semibold text-white transition hover:bg-[#3F3E7B] focus:outline-none focus:ring-2 focus:ring-[#4B4A8F]/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Analyzing page..." : "Connect page"}
          </button>
          <button
            type="button"
            onClick={() => setRawText(SAMPLE_TEXT)}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-[8px] border border-[#DCDCD6] bg-white px-4 text-sm font-semibold text-[#1F1F1D] transition hover:bg-[#F7F7F5]"
          >
            Use sample page
          </button>
        </div>
      </div>
    </form>
  );
}

export default function HomePage() {
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [deviceId, setDeviceId] = useState("paperloom-browser-console-001");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scanStage, setScanStage] = useState<ScanStage>("idle");
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<IngestResponse, { success: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const rawTextStats = useMemo(() => {
    const words = rawText.trim().split(/\s+/).filter(Boolean);
    const paragraphs = splitIntoParagraphs(rawText);

    return {
      words: words.length,
      paragraphs: paragraphs.length,
      characters: rawText.length,
    };
  }, [rawText]);

  const documentTitle = useMemo(() => inferDocumentTitle(rawText), [rawText]);

  const documents = useMemo<DocumentListItem[]>(() => {
    const connectedDocument =
      result && fingerprintHash
        ? [
            {
              title: documentTitle,
              scannedAt: "Scanned just now",
              status: "Ready",
              gapCount: result.missing_concepts_count,
              href: result.dashboard_path ?? `/dashboard/${fingerprintHash}`,
              isActive: true,
            },
          ]
        : [];

    return [
      ...connectedDocument,
      {
        title: documentTitle,
        scannedAt: result ? "Sample page" : "Ready to connect",
        status: result ? "Verified" : "Draft",
        gapCount: result?.missing_concepts_count ?? null,
        href: result && fingerprintHash ? result.dashboard_path ?? `/dashboard/${fingerprintHash}` : "#new-scan",
        isActive: Boolean(result),
      },
      {
        title: "Laws of Motion",
        scannedAt: "Yesterday",
        status: "Ready",
        gapCount: 2,
      },
      {
        title: "Cell Structure Notes",
        scannedAt: "Last week",
        status: "Reviewing",
        gapCount: 5,
      },
    ];
  }, [documentTitle, fingerprintHash, result]);

  async function handleCopyFingerprint() {
    if (!fingerprintHash || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(fingerprintHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setScanStage("reading");
    setError(null);
    setResult(null);
    setCopied(false);

    let analysisTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      await pause(180);
      setScanStage("fingerprinting");
      const hash = await sha256Hex(makePseudoFiberPayload(rawText));
      setFingerprintHash(hash);

      await pause(180);
      setScanStage("verifying");

      analysisTimer = setTimeout(() => {
        setScanStage("analyzing");
      }, 900);

      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: deviceId,
          fingerprint_hash: hash,
          raw_text: rawText,
        }),
      });

      const body = (await response.json()) as IngestResponse;

      if (!response.ok || !body.success) {
        throw new Error(body.success === false ? body.error : "PaperLoom ingest failed");
      }

      if (analysisTimer) {
        clearTimeout(analysisTimer);
      }

      setScanStage("creating");
      storePaperLoomToken(body.token);
      setResult(body);
      await pause(180);
      setScanStage("complete");
    } catch (submitError) {
      if (analysisTimer) {
        clearTimeout(analysisTimer);
      }

      setScanStage("error");
      setError(submitError instanceof Error ? submitError.message : "The scan could not be processed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#F7F7F5] text-[#1F1F1D]">
      <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
        <AppSidebar recentDocuments={documents} />
        <div className="min-w-0">
          <MobileTopBar />

          <div className="mx-auto max-w-[1220px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <DocumentsPanel documents={documents} />

            <section id="new-scan" className="mt-10 scroll-mt-6">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm text-[#6F6F6B]">
                    <a href="#documents" className="font-medium text-[#4B4A8F]">
                      Documents
                    </a>
                    <ChevronRight className="h-4 w-4" strokeWidth={1.8} />
                    <span>New scan</span>
                  </div>
                  <h2 className="mt-2 text-[28px] font-semibold tracking-tight text-[#1F1F1D]">Connect a page</h2>
                </div>
                <div className="flex items-center gap-2 text-sm text-[#6F6F6B]">
                  <ShieldCheck className="h-4 w-4 text-[#4B4A8F]" strokeWidth={1.8} />
                  Page identity stays attached to this workspace
                </div>
              </div>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                <PagePreview rawText={rawText} stats={rawTextStats} deviceId={deviceId} />
                <ScanPanel
                  deviceId={deviceId}
                  setDeviceId={setDeviceId}
                  rawText={rawText}
                  setRawText={setRawText}
                  stats={rawTextStats}
                  fingerprintHash={fingerprintHash}
                  isSubmitting={isSubmitting}
                  stage={scanStage}
                  result={result}
                  error={error}
                  isEditorOpen={isEditorOpen}
                  setIsEditorOpen={setIsEditorOpen}
                  copied={copied}
                  onCopyFingerprint={handleCopyFingerprint}
                  onSubmit={handleSubmit}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
