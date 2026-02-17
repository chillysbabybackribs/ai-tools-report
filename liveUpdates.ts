/**
 * Live Intelligence Tape Data
 * Real-time updates on agent market developments
 * Format: category, headline, context, timestamp
 */

export interface LiveUpdate {
  id: string;
  category: "INDEX" | "AGENTS" | "SECURITY" | "ECOSYSTEM" | "MODELS";
  headline: string;
  context: string;
  timestamp: string;
  link?: string;
}

export const liveUpdates: LiveUpdate[] = [
  {
    id: "update-001",
    category: "INDEX",
    headline: "CrewAI ARI reduced 52 → 47",
    context: "after sandbox update strengthens permission model",
    timestamp: "2026-02-16T14:32:00Z",
  },
  {
    id: "update-002",
    category: "AGENTS",
    headline: "OpenClaw adds native Claude integration",
    context: "MCP bidirectional streaming now live for tool calls",
    timestamp: "2026-02-16T12:15:00Z",
  },
  {
    id: "update-003",
    category: "SECURITY",
    headline: "LangChain patches tool injection vulnerability",
    context: "CVE-2026-4521 affects <0.0.242, update recommended",
    timestamp: "2026-02-15T18:42:00Z",
  },
  {
    id: "update-004",
    category: "ECOSYSTEM",
    headline: "MCP adoption crosses 12K endpoints",
    context: "Linux Foundation governance now active, vendor commitments binding",
    timestamp: "2026-02-15T10:08:00Z",
  },
  {
    id: "update-005",
    category: "MODELS",
    headline: "Claude Opus 4.6 enterprise tier expanded",
    context: "Token limits increased 2x, tooluse concurrency now 8 parallel calls",
    timestamp: "2026-02-14T16:20:00Z",
  },
  {
    id: "update-006",
    category: "INDEX",
    headline: "n8n EPI upgraded from 72 to 78",
    context: "10M+ monthly active users confirmed by vendor, enterprise adoption +35% YoY",
    timestamp: "2026-02-14T09:35:00Z",
  },
  {
    id: "update-007",
    category: "AGENTS",
    headline: "Anthropic releases Agent Evals public benchmark",
    context: "OSWorld, SWE-bench, Terminal-Bench scores now reproducible and open-source",
    timestamp: "2026-02-13T11:22:00Z",
  },
  {
    id: "update-008",
    category: "SECURITY",
    headline: "Microsoft AutoGen adds permission layer",
    context: "Fine-grained tool access control, audit logging enabled by default",
    timestamp: "2026-02-13T08:44:00Z",
  },
];

/**
 * Get updates sorted by timestamp (newest first)
 */
export function getSortedUpdates(): LiveUpdate[] {
  return [...liveUpdates].sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Get updates by category
 */
export function getUpdatesByCategory(
  category: LiveUpdate["category"]
): LiveUpdate[] {
  return liveUpdates.filter((u) => u.category === category);
}

/**
 * Render tape content for HTML
 */
export function renderTapeContent(): string {
  const updates = getSortedUpdates();
  // Duplicate for seamless scroll effect
  const doubled = [...updates, ...updates];

  return doubled
    .map((update) => {
      const categoryClass = update.category.toLowerCase();
      return `
    <div class="tape-item">
      <span class="tape-category ${categoryClass}">${update.category}</span>
      <span class="tape-headline">${update.headline}</span>
      <span class="tape-context">— ${update.context}</span>
    </div>
  `;
    })
    .join("");
}
