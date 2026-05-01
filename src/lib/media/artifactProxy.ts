const DEFAULT_FLY_ARTIFACT_PROXY_URL = 'https://genedit-pro.fly.dev/api/artifact-proxy';

export function artifactProxyUrl(sourceUrl: string): string | null {
  const configuredProxy = import.meta.env.VITE_ARTIFACT_PROXY_URL?.trim();
  const proxyBase = configuredProxy || defaultArtifactProxyBase();
  if (!proxyBase) return null;

  const url = new URL(proxyBase);
  url.searchParams.set('url', sourceUrl);
  return url.toString();
}

export function isFetchBlockedError(error: unknown): boolean {
  return error instanceof TypeError;
}

function defaultArtifactProxyBase(): string | null {
  if (typeof window === 'undefined') return null;

  const { hostname, origin, protocol } = window.location;
  if (hostname === 'genedit-pro.fly.dev') return `${origin}/api/artifact-proxy`;
  if (hostname === 'sollaholla.github.io') return DEFAULT_FLY_ARTIFACT_PROXY_URL;
  if (protocol === 'https:' && !hostname.endsWith('.github.io')) return `${origin}/api/artifact-proxy`;
  return null;
}
