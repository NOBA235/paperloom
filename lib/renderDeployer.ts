export type RenderServiceType =
  | "static_site"
  | "web_service"
  | "private_service"
  | "background_worker"
  | "cron_job";

export type RenderAutoDeploy = "yes" | "no";

export type RenderEnvironmentVariable =
  | {
      key: string;
      value: string;
    }
  | {
      key: string;
      generateValue: boolean;
    };

export type RenderSecretFile = {
  name: string;
  content: string;
};

export type RenderStaticSiteDetailsPost = {
  buildCommand?: string;
  publishPath?: string;
  pullRequestPreviewsEnabled?: "yes" | "no";
  previews?: {
    generation?: "off" | "manual" | "automatic";
  };
  headers?: Array<{
    path: string;
    name: string;
    value: string;
  }>;
  routes?: Array<{
    type: "redirect" | "rewrite";
    source: string;
    destination: string;
  }>;
};

export type RenderCreateServiceRequest = {
  type: RenderServiceType;
  name: string;
  ownerId: string;
  repo?: string;
  autoDeploy?: RenderAutoDeploy;
  branch?: string;
  rootDir?: string;
  envVars?: RenderEnvironmentVariable[];
  secretFiles?: RenderSecretFile[];
  environmentId?: string;
  serviceDetails?: RenderStaticSiteDetailsPost;
};

export type RenderService = {
  id: string;
  type: RenderServiceType | string;
  name: string;
  repo?: string;
  branch?: string;
  autoDeploy?: boolean | RenderAutoDeploy;
  createdAt?: string;
  updatedAt?: string;
  serviceDetails?: {
    url?: string;
    buildCommand?: string;
    publishPath?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type RenderDeploy = {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  commit?: {
    id?: string;
    message?: string;
    createdAt?: string;
  };
  [key: string]: unknown;
};

export type RenderCreateServiceResponse = {
  service?: RenderService;
  deployId?: string;
  deploy?: RenderDeploy;
  id?: string;
  name?: string;
  type?: string;
  serviceDetails?: RenderService["serviceDetails"];
  [key: string]: unknown;
};

export type DeployStudentWorkspaceResult = {
  serviceId: string;
  serviceName: string;
  serviceUrl: string | null;
  deployId: string | null;
  fingerprintHash: string;
  noteId: string;
  renderResponse: RenderCreateServiceResponse;
};

type RenderErrorBody = {
  id?: string;
  message?: string;
  error?: string;
  errors?: unknown;
  details?: unknown;
  [key: string]: unknown;
};

type RenderRequestOptions = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  maxAttempts?: number;
};

const DEFAULT_RENDER_API_BASE_URL = "https://api.render.com/v1";
const DEFAULT_BUILD_COMMAND = "npm install && npm run build";
const DEFAULT_PUBLISH_PATH = "out";
const DEFAULT_BRANCH = "main";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export class RenderDeploymentError extends Error {
  readonly statusCode?: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    code: string;
    statusCode?: number;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "RenderDeploymentError";
    this.statusCode = args.statusCode;
    this.code = args.code;
    this.retryable = args.retryable ?? false;
    this.details = args.details;
  }
}

export class RenderAuthenticationError extends RenderDeploymentError {
  constructor(message: string, statusCode: number, details?: unknown) {
    super({
      message,
      code: "render_authentication_failed",
      statusCode,
      retryable: false,
      details,
    });
    this.name = "RenderAuthenticationError";
  }
}

export class RenderConfigurationError extends RenderDeploymentError {
  constructor(message: string, statusCode: number, details?: unknown) {
    super({
      message,
      code: "render_configuration_invalid",
      statusCode,
      retryable: false,
      details,
    });
    this.name = "RenderConfigurationError";
  }
}

export class RenderRateLimitError extends RenderDeploymentError {
  constructor(message: string, statusCode: number, details?: unknown) {
    super({
      message,
      code: "render_rate_limited",
      statusCode,
      retryable: true,
      details,
    });
    this.name = "RenderRateLimitError";
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new RenderConfigurationError(`Missing required environment variable: ${name}`, 0);
  }

  return value.trim();
}

function getOptionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function getOptionalEnvOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function validateFingerprintHash(fingerprintHash: string): string {
  const normalized = fingerprintHash.trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new RenderConfigurationError(
      "fingerprint_hash must be a 64-character SHA-256 hexadecimal digest",
      0,
      { fingerprintHash },
    );
  }

  return normalized;
}

function validateNoteId(noteId: string): string {
  const normalized = noteId.trim();

  if (!/^[0-9a-fA-F-]{20,80}$/.test(normalized)) {
    throw new RenderConfigurationError("note_id must be a valid persisted document identifier", 0, { noteId });
  }

  return normalized;
}

function buildStudentWorkspaceName(fingerprintHash: string, noteId: string): string {
  const noteSegment = noteId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  const fingerprintSegment = fingerprintHash.slice(0, 16);
  const entropySegment = Date.now().toString(36);
  return `paperloom-${noteSegment}-${fingerprintSegment}-${entropySegment}`.slice(0, 63);
}

function createStudentEnvironmentVariables(
  fingerprintHash: string,
  noteId: string,
): RenderEnvironmentVariable[] {
  return [
    {
      key: "PAPERLOOM_FINGERPRINT_HASH",
      value: fingerprintHash,
    },
    {
      key: "PAPERLOOM_NOTE_ID",
      value: noteId,
    },
    {
      key: "PAPERLOOM_WORKSPACE_MODE",
      value: "student_session",
    },
    {
      key: "NEXT_PUBLIC_PAPERLOOM_NOTE_ID",
      value: noteId,
    },
  ];
}

function createRenderServicePayload(fingerprintHash: string, noteId: string): RenderCreateServiceRequest {
  const rootDir = getOptionalEnvOrUndefined("RENDER_DASHBOARD_ROOT_DIR");
  const environmentId = getOptionalEnvOrUndefined("RENDER_ENVIRONMENT_ID");
  const payload: RenderCreateServiceRequest = {
    type: "static_site",
    name: buildStudentWorkspaceName(fingerprintHash, noteId),
    ownerId: getRequiredEnv("RENDER_OWNER_ID"),
    repo: getRequiredEnv("RENDER_DASHBOARD_REPO"),
    autoDeploy: "no",
    branch: getOptionalEnv("RENDER_DASHBOARD_BRANCH", DEFAULT_BRANCH),
    envVars: createStudentEnvironmentVariables(fingerprintHash, noteId),
    serviceDetails: {
      buildCommand: getOptionalEnv("RENDER_DASHBOARD_BUILD_COMMAND", DEFAULT_BUILD_COMMAND),
      publishPath: getOptionalEnv("RENDER_DASHBOARD_PUBLISH_PATH", DEFAULT_PUBLISH_PATH),
      pullRequestPreviewsEnabled: "no",
      previews: {
        generation: "off",
      },
    },
  };

  if (rootDir) {
    payload.rootDir = rootDir;
  }

  if (environmentId) {
    payload.environmentId = environmentId;
  }

  return payload;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);

  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function getBackoffDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, 60_000);
  }

  const baseDelay = Math.min(1000 * 2 ** (attempt - 1), 20_000);
  const jitter = Math.floor(Math.random() * 500);
  return baseDelay + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parseRenderResponseBody(response: Response): Promise<RenderErrorBody | unknown> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as RenderErrorBody;
  } catch {
    return {
      message: text,
    };
  }
}

function getRenderErrorMessage(body: RenderErrorBody | unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const objectBody = body as RenderErrorBody;
    const message = objectBody.message ?? objectBody.error;

    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }

    if (objectBody.errors !== undefined) {
      return `${fallback}: ${JSON.stringify(objectBody.errors)}`;
    }

    if (objectBody.details !== undefined) {
      return `${fallback}: ${JSON.stringify(objectBody.details)}`;
    }
  }

  return fallback;
}

function classifyRenderHttpError(response: Response, body: RenderErrorBody | unknown): RenderDeploymentError {
  const fallback = `Render API request failed with HTTP ${response.status}`;
  const message = getRenderErrorMessage(body, fallback);

  if (response.status === 401 || response.status === 403) {
    return new RenderAuthenticationError(
      `Render rejected the API credentials or workspace permissions: ${message}`,
      response.status,
      body,
    );
  }

  if (response.status === 400 || response.status === 404 || response.status === 409 || response.status === 402) {
    return new RenderConfigurationError(
      `Render rejected the service configuration: ${message}`,
      response.status,
      body,
    );
  }

  if (response.status === 429) {
    return new RenderRateLimitError(`Render rate limit exceeded: ${message}`, response.status, body);
  }

  return new RenderDeploymentError({
    message,
    code: "render_api_error",
    statusCode: response.status,
    retryable: response.status >= 500 || response.status === 429,
    details: body,
  });
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function isRetryableError(error: unknown): boolean {
  return (
    error instanceof RenderRateLimitError ||
    (error instanceof RenderDeploymentError && error.retryable) ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function renderApiRequest<T>(options: RenderRequestOptions): Promise<T> {
  const apiKey = getRequiredEnv("RENDER_API_KEY");
  const baseUrl = getOptionalEnv("RENDER_API_BASE_URL", DEFAULT_RENDER_API_BASE_URL).replace(/\/+$/, "");
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}${options.path}`, {
        method: options.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (response.ok) {
        const body = await parseRenderResponseBody(response);
        return body as T;
      }

      const body = await parseRenderResponseBody(response);
      const error = classifyRenderHttpError(response, body);
      lastError = error;

      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        await sleep(getBackoffDelayMs(attempt, retryAfterMs));
        continue;
      }

      throw error;
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts && isRetryableError(error)) {
        await sleep(getBackoffDelayMs(attempt, null));
        continue;
      }

      if (error instanceof RenderDeploymentError) {
        throw error;
      }

      throw new RenderDeploymentError({
        message: error instanceof Error ? error.message : "Render API request failed before receiving a response",
        code: "render_network_error",
        retryable: true,
        details: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new RenderDeploymentError({
    message: "Render API request exhausted all retry attempts",
    code: "render_retry_exhausted",
    retryable: true,
    details: lastError,
  });
}

function extractCreatedService(response: RenderCreateServiceResponse): RenderService {
  const service = response.service ?? response;

  if (!service || typeof service !== "object") {
    throw new RenderDeploymentError({
      message: "Render service creation response did not include a service object",
      code: "render_response_malformed",
      retryable: false,
      details: response,
    });
  }

  const id = "id" in service ? service.id : undefined;
  const name = "name" in service ? service.name : undefined;

  if (typeof id !== "string" || id.trim().length === 0 || typeof name !== "string" || name.trim().length === 0) {
    throw new RenderDeploymentError({
      message: "Render service creation response was missing service id or name",
      code: "render_response_malformed",
      retryable: false,
      details: response,
    });
  }

  return service as RenderService;
}

function extractServiceUrl(service: RenderService): string | null {
  const url = service.serviceDetails?.url;

  if (typeof url === "string" && url.trim().length > 0) {
    return url;
  }

  return null;
}

export async function deployStudentWorkspace(
  fingerprint_hash: string,
  note_id: string,
): Promise<DeployStudentWorkspaceResult> {
  const fingerprintHash = validateFingerprintHash(fingerprint_hash);
  const noteId = validateNoteId(note_id);
  const createServicePayload = createRenderServicePayload(fingerprintHash, noteId);
  const renderResponse = await renderApiRequest<RenderCreateServiceResponse>({
    method: "POST",
    path: "/services",
    body: createServicePayload,
  });

  const service = extractCreatedService(renderResponse);
  const deployId =
    typeof renderResponse.deployId === "string"
      ? renderResponse.deployId
      : renderResponse.deploy && typeof renderResponse.deploy.id === "string"
        ? renderResponse.deploy.id
        : null;

  return {
    serviceId: service.id,
    serviceName: service.name,
    serviceUrl: extractServiceUrl(service),
    deployId,
    fingerprintHash,
    noteId,
    renderResponse,
  };
}
