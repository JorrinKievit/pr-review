const PR_FILES = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(files|changes)(\/|$)/

/** The extension review page for a PR "Files changed" URL, or null to leave GitHub alone. */
export function reviewUrlFor(url: string, extBase: string): string | null {
  const u = new URL(url)
  if (u.searchParams.get('native') === '1') return null
  const m = PR_FILES.exec(u.pathname)
  if (!m) return null
  const [, owner, repo, n] = m
  return `${extBase}review.html#/open/${u.host}/${owner}/${repo}/${n}`
}
