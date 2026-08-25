import { SessionCookie } from "../auth/access";
import { fetchModelsViaBrowser } from "./browser-client";

/**
 * Discovering which models the user's account actually has.
 *
 * Hardcoding slugs does not work: OpenAI ships, renames and retires models far
 * faster than a pinned list can track, and entitlements differ per account
 * anyway — Free, Plus, Pro and Team all see different sets. A slug that is
 * wrong or unavailable does not fail loudly either; `?model=<slug>` quietly
 * falls back to the default, so the user would believe they were on a model
 * they were not.
 *
 * So the list comes from the account. `/backend-api/models` is what the web UI
 * itself calls to populate its model picker.
 */

export interface RemoteModel {
  slug: string;
  title: string;
  description: string;
  /** Tags the backend attaches, e.g. entitlement or capability markers. */
  tags: string[];
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface ModelsResponse {
  models?: {
    slug?: string;
    title?: string;
    description?: string;
    tags?: string[];
    // Some responses nest the human-readable bits.
    product_features?: unknown;
  }[];
  categories?: {
    category?: string;
    human_category_name?: string;
    default_model?: string;
  }[];
}

function normalise(raw: ModelsResponse): RemoteModel[] {
  const out: RemoteModel[] = [];
  for (const m of raw.models ?? []) {
    const slug = typeof m.slug === "string" ? m.slug.trim() : "";
    if (!slug) continue;
    out.push({
      slug,
      title: typeof m.title === "string" && m.title.trim() ? m.title.trim() : slug,
      description:
        typeof m.description === "string" && m.description.trim()
          ? m.description.trim().replace(/\s+/g, " ")
          : "",
      tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [],
    });
  }
  return out;
}

/** Direct backend call. Fast, but needs an access token Cloudflare may refuse. */
async function viaApi(accessToken: string, cookies: SessionCookie[], deviceId?: string): Promise<RemoteModel[]> {
  if (!accessToken) throw new Error("no access token");
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "oai-language": "en-US",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "user-agent": UA,
  };
  if (deviceId) headers["oai-device-id"] = deviceId;
  if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await fetch("https://chatgpt.com/backend-api/models", { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const models = normalise((await res.json()) as ModelsResponse);
  if (models.length === 0) throw new Error("empty model list");
  return models;
}

export interface DiscoveryResult {
  models: RemoteModel[];
  /** Which path produced the list, for the status line. */
  source: "api" | "browser";
}

/**
 * Ask the user's account which models it has.
 *
 * The API path is tried first because it is a single request; the browser path
 * is the reliable fallback, since it runs the same fetch from inside the
 * logged-in page where Cloudflare is already satisfied.
 */
export async function discoverModels(auth: {
  accessToken: string;
  cookies: SessionCookie[];
  deviceId?: string;
}): Promise<DiscoveryResult> {
  const failures: string[] = [];

  try {
    return { models: await viaApi(auth.accessToken, auth.cookies, auth.deviceId), source: "api" };
  } catch (e) {
    failures.push(`api: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const models = normalise(await fetchModelsViaBrowser(auth.cookies));
    if (models.length === 0) throw new Error("empty model list");
    return { models, source: "browser" };
  } catch (e) {
    failures.push(`browser: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(`Could not read the model list from your account (${failures.join("; ")})`);
}
