/**
 * The GitHub repo ("owner/name") that update checks and announcements come from.
 *
 * null turns both off. Every build keeps checking this repo for as long as it stays installed,
 * so it must be the repo's final home.
 */
export const GITHUB_REPO: string | null = 'edbergc7/marbles'

/** Branch that holds announcements.json. */
export const ANNOUNCEMENTS_BRANCH = 'main'
