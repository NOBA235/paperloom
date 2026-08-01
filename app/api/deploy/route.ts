import { NextRequest, NextResponse } from "next/server";
import jwt, { type JwtPayload, type Secret } from "jsonwebtoken";
import { z } from "zod";
import { deployStudentWorkspace, RenderDeploymentError } from "@/lib/renderDeployer";

export const runtime = "nodejs";

const deployRequestSchema = z.object({
  fingerprint_hash: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{64}$/)
    .transform((value) => value.toLowerCase()),
  note_id: z.string().trim().uuid(),
});

function jsonResponse(body: unknown, status: number) {
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

  return value.trim();
}

function getBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token.trim();
}

function verifyFingerprintToken(token: string, fingerprintHash: string): void {
  const secret: Secret = getRequiredEnv("SUPABASE_JWT_SECRET");
  const decoded = jwt.verify(token, secret, {
    audience: "authenticated",
  });

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Token payload was not an object");
  }

  const payload = decoded as JwtPayload & {
    fingerprint_hash?: string;
    scope?: string;
  };

  if (payload.fingerprint_hash !== fingerprintHash || payload.scope !== "paperloom:fingerprint") {
    throw new Error("Token fingerprint claim does not match requested workspace");
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return jsonResponse(
        {
          success: false,
          error: "Missing bearer token",
        },
        401,
      );
    }

    const body = await request.json();
    const parsed = deployRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid deploy payload",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    verifyFingerprintToken(token, parsed.data.fingerprint_hash);

    const deployment = await deployStudentWorkspace(parsed.data.fingerprint_hash, parsed.data.note_id);

    return jsonResponse(
      {
        success: true,
        workspace: {
          serviceId: deployment.serviceId,
          serviceName: deployment.serviceName,
          serviceUrl: deployment.serviceUrl,
          deployId: deployment.deployId,
        },
      },
      200,
    );
  } catch (error) {
    if (error instanceof RenderDeploymentError) {
      return jsonResponse(
        {
          success: false,
          error: error.message,
          code: error.code,
          details: process.env.NODE_ENV === "production" ? undefined : error.details,
        },
        error.statusCode && error.statusCode > 0 ? error.statusCode : 500,
      );
    }

    const message = error instanceof Error ? error.message : "Unable to deploy workspace";

    return jsonResponse(
      {
        success: false,
        error: "Workspace deployment failed",
        details: process.env.NODE_ENV === "production" ? undefined : message,
      },
      message.toLowerCase().includes("token") ? 401 : 500,
    );
  }
}
