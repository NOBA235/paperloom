"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.07] p-4">
      <p className="text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-400">{label}</p>
    </div>
  );
}

export default function HomePage() {
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [deviceId, setDeviceId] = useState("paperloom-browser-console-001");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<IngestResponse, { success: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rawTextStats = useMemo(() => {
    const words = rawText.trim().split(/\s+/).filter(Boolean);
    const paragraphs = rawText.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);

    return {
      words: words.length,
      paragraphs: paragraphs.length,
      characters: rawText.length
    };
  }, [rawText]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const hash = await sha256Hex(makePseudoFiberPayload(rawText));
      setFingerprintHash(hash);

      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          device_id: deviceId,
          fingerprint_hash: hash,
          raw_text: rawText
        })
      });

      const body = (await response.json()) as IngestResponse;

      if (!response.ok || !body.success) {
        throw new Error(body.success === false ? body.error : "PaperLoom ingest failed");
      }

      storePaperLoomToken(body.token);
      setResult(body);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The scan could not be processed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#020617,#0f172a_42%,#082f49)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[0.95fr_1.25fr]">
        <section className="rounded-lg border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.24),transparent_34%),rgba(15,23,42,0.88)] p-6 shadow-glow">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">PaperLoom</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Physical notes become secure AI workspaces.
          </h1>
          <p className="mt-5 text-sm leading-7 text-slate-300">
            Paste a scan, simulate the hardware fingerprint, mint the Supabase RLS token, and open a document-bound learning dashboard.
          </p>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <Metric label="Words" value={String(rawTextStats.words)} />
            <Metric label="Blocks" value={String(rawTextStats.paragraphs)} />
            <Metric label="Chars" value={String(rawTextStats.characters)} />
          </div>
          <div className="mt-6 rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-4">
            <p className="font-mono text-xs leading-6 text-cyan-100">
              {fingerprintHash
                ? `fingerprint_hash=${fingerprintHash}`
                : "fingerprint_hash will appear after the secure scan is generated"}
            </p>
          </div>
          {result ? (
            <div className="mt-5 rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4">
              <p className="text-sm font-semibold text-emerald-100">Workspace minted</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {result.missing_concepts_count} gaps and {result.verified_resources_count} resources saved.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={result.dashboard_path ?? `/dashboard/${fingerprintHash}`}
                  className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
                >
                  Open Dashboard
                </Link>
                {result.render_workspace?.serviceUrl ? (
                  <a
                    href={result.render_workspace.serviceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    Render Instance
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="mt-5 rounded-lg border border-red-300/30 bg-red-300/10 p-4 text-sm leading-6 text-red-100">
              {error}
            </div>
          ) : null}
        </section>

        <form onSubmit={handleSubmit} className="rounded-lg border border-white/10 bg-white p-5 text-slate-950 shadow-2xl shadow-slate-950/20">
          <div className="grid gap-4 lg:grid-cols-[0.75fr_1.25fr]">
            <label className="block">
              <span className="text-sm font-semibold text-slate-800">Device ID</span>
              <input
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                className="mt-2 w-full rounded-lg border-slate-300 text-sm shadow-sm focus:border-cyan-500 focus:ring-cyan-500"
                minLength={1}
                maxLength={128}
                required
              />
            </label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              This console uses browser SHA-256 over a deterministic pseudo-fiber payload. The Wokwi ESP32 simulator uses its own mocked sensor array.
            </div>
          </div>

          <label className="mt-5 block">
            <span className="text-sm font-semibold text-slate-800">Raw Text Scan</span>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              className="paperloom-scrollbar mt-2 min-h-[520px] w-full rounded-lg border-slate-300 font-mono text-sm leading-6 shadow-sm focus:border-cyan-500 focus:ring-cyan-500"
              minLength={16}
              maxLength={500000}
              required
            />
          </label>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Auditing Scan..." : "Mint Secure Workspace"}
            </button>
            <button
              type="button"
              onClick={() => setRawText(SAMPLE_TEXT)}
              className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-cyan-400 hover:bg-cyan-50"
            >
              Restore Sample
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
