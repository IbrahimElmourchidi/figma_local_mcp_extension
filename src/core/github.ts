import { BridgeError } from '../errors';
import { UPSTREAM_OWNER, UPSTREAM_REPO, githubApiRepoUrl } from '../constants';

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'figma-mcp-bridge-vscode',
};

/**
 * GET JSON with a 10s timeout. Returns null on 404. Throws BridgeError otherwise.
 */
export async function getJson<T = unknown>(url: string, timeoutMs = 10_000): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: GITHUB_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new BridgeError('download_failed', `Timed out fetching ${url}`);
    }
    throw new BridgeError('download_failed', `Network error fetching ${url}: ${String(error)}`);
  }

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new BridgeError('download_failed', `HTTP ${response.status} fetching ${url}`);
  }
  return (await response.json()) as T;
}

export interface ResolvedRef {
  readonly sha: string;
  readonly committedAt?: string;
}

interface CommitPayload {
  sha?: string;
  commit?: { committer?: { date?: string } };
}

/** Resolve a branch/tag/sha on the upstream repo to a concrete commit. */
export async function resolveRef(ref: string): Promise<ResolvedRef> {
  const url = githubApiRepoUrl(`commits/${encodeURIComponent(ref)}`);
  const payload = await getJson<CommitPayload>(url);
  if (!payload?.sha) {
    throw new BridgeError('download_failed', `Could not resolve upstream ref "${ref}"`);
  }
  return {
    sha: payload.sha,
    committedAt: payload.commit?.committer?.date,
  };
}

export function upstreamRepoSlug(): string {
  return `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;
}
