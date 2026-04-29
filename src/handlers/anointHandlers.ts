import { wrapHandler } from '../utils/errorHandling.js';
import type {
  AnointCandidateResult,
  AnointEvaluationResult,
  AnointMetricSnapshot,
  AnointStatDelta,
  PoBLuaApiClient,
} from '../pobLuaBridge.js';

interface AnointHandlerContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

const HEADLINE_STATS = new Set([
  'CombinedDPS',
  'TotalDPS',
  'FullDPS',
  'FullDotDPS',
  'SkillDPS',
  'TotalEHP',
  'EHP',
]);

function formatNumber(value: number, maximumFractionDigits = 0): string {
  const normalized = Math.abs(value) < 0.0005 ? 0 : value;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(normalized);
}

function formatSigned(value: number, maximumFractionDigits = 0): string {
  const normalized = Math.abs(value) < 0.0005 ? 0 : value;
  const sign = normalized > 0 ? '+' : '';
  return `${sign}${formatNumber(normalized, maximumFractionDigits)}`;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatDeltaWithPercent(delta: number, denominator: number): string {
  const percent = denominator > 0 ? (delta / denominator) * 100 : 0;
  return `${formatSigned(delta)} (${formatPercent(percent)})`;
}

function getDpsMetric(result: AnointEvaluationResult): string {
  return result.dpsMetric ?? result.currentAnoint?.dpsMetric ?? result.candidates.find((candidate) => candidate.dpsMetric)?.dpsMetric ?? 'CombinedDPS';
}

function getDpsValue(snapshot: AnointMetricSnapshot | undefined, metric: string): number {
  if (!snapshot) return 0;
  const value = snapshot[metric as keyof AnointMetricSnapshot];
  return typeof value === 'number' ? value : snapshot.DPS ?? snapshot.CombinedDPS;
}

function getBaseDps(result: AnointEvaluationResult): number {
  return getDpsValue(result.base, getDpsMetric(result));
}

function formatEffectLines(prefix: string, statLines?: string[]): string[] {
  if (!statLines || statLines.length === 0) {
    return [`   ${prefix}: unavailable from PoB bridge`];
  }
  return [`   ${prefix}:`, ...statLines.map((line) => `     - ${line}`)];
}

function formatCurrentAnoint(result: AnointEvaluationResult): string[] {
  const hasCurrentMetadata = Object.prototype.hasOwnProperty.call(result, 'currentAnoint');
  if (!hasCurrentMetadata) {
    return [
      'Current anoint: unavailable from PoB bridge',
      'Current contribution vs no anoint: unavailable from PoB bridge',
    ];
  }

  const current = result.currentAnoint;
  if (!current) {
    return ['Current anoint: none detected'];
  }

  const lines = [
    `Current anoint: **${current.name}**${current.nodeId !== undefined ? ` [${current.nodeId}]` : ''}`,
    `Current contribution vs no anoint: ${getDpsMetric(result)} delta ${formatDeltaWithPercent(current.dpsDelta ?? 0, getBaseDps(result))}  |  EHP delta ${formatDeltaWithPercent(current.ehpDelta ?? 0, result.base.TotalEHP)}`,
  ];
  lines.push(...formatEffectLines('Current effect', current.statLines));
  return lines;
}

function getCurrentDps(result: AnointEvaluationResult): number {
  const metric = getDpsMetric(result);
  return result.current ? getDpsValue(result.current, metric) : getBaseDps(result) + (result.currentAnoint?.dpsDelta ?? 0);
}

function getCurrentEhp(result: AnointEvaluationResult): number {
  return result.current?.TotalEHP ?? result.base.TotalEHP + (result.currentAnoint?.ehpDelta ?? 0);
}

function getFilteredStatDeltas(candidate: AnointCandidateResult): AnointStatDelta[] | undefined {
  if (!candidate.statDeltas) return undefined;
  return candidate.statDeltas.filter((delta) => !HEADLINE_STATS.has(delta.stat ?? ''));
}

function formatStatDelta(delta: AnointStatDelta): string {
  const label = delta.actor ? `${delta.actor} ${delta.label}` : delta.label;
  const pieces = [`${label}: ${formatSigned(delta.delta, 2)}`];
  if (delta.current !== undefined && delta.candidate !== undefined) {
    pieces.push(`(${formatNumber(delta.current, 2)} -> ${formatNumber(delta.candidate, 2)})`);
  }
  if (delta.percentDelta !== undefined) {
    pieces.push(`(${formatPercent(delta.percentDelta)})`);
  }
  return pieces.join(' ');
}

function formatSecondaryDeltas(candidate: AnointCandidateResult): string[] {
  const statDeltas = getFilteredStatDeltas(candidate);
  if (!statDeltas) {
    return ['   Secondary stat deltas vs current: unavailable from PoB bridge'];
  }
  if (statDeltas.length === 0) {
    return ['   Secondary stat deltas vs current: no display-stat changes beyond DPS/EHP'];
  }

  const lines = [
    '   Secondary stat deltas vs current:',
    ...statDeltas.map((delta) => `     - ${formatStatDelta(delta)}`),
  ];
  const losses = statDeltas.filter((delta) => delta.delta < -0.0005 && delta.lowerIsBetter !== true);
  if (losses.length > 0) {
    lines.push(`   Potential losses: ${losses.map((delta) => delta.label).join(', ')}`);
  }
  return lines;
}

function formatCandidateDeltas(
  candidate: AnointCandidateResult,
  result: AnointEvaluationResult,
): string[] {
  const lines = [
    `   Score vs no anoint: ${candidate.score.toFixed(4)}  |  ${getDpsMetric(result)} delta vs no anoint: ${formatDeltaWithPercent(candidate.dpsDelta, getBaseDps(result))}  |  EHP delta vs no anoint: ${formatDeltaWithPercent(candidate.ehpDelta, result.base.TotalEHP)}`,
  ];

  if (candidate.swapDpsDelta !== undefined || candidate.swapEhpDelta !== undefined) {
    lines.push(
      `   Net swap vs current: ${getDpsMetric(result)} delta ${formatDeltaWithPercent(candidate.swapDpsDelta ?? 0, getCurrentDps(result))}  |  EHP delta ${formatDeltaWithPercent(candidate.swapEhpDelta ?? 0, getCurrentEhp(result))}`,
    );
  } else {
    lines.push('   Net swap vs current: unavailable from PoB bridge');
  }

  return lines;
}

/**
 * Find the best anointable notable for the loaded build by simulating the
 * impact of each anoint candidate via PoB's MiscCalculator (non-destructive,
 * same mechanism the GUI uses to sort anoints in the item picker).
 *
 * Requires an anointable item equipped in the target slot:
 * - Amulet (any base)
 * - Belt: Cord Belt only
 */
export async function handleFindBestAnointment(
  context: AnointHandlerContext,
  args: { slot: string; focus?: 'dps' | 'defence' | 'both'; max_results?: number },
) {
  return wrapHandler('find best anointment', async () => {
    await context.ensureLuaClient();
    const client = context.getLuaClient();
    if (!client) {
      throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');
    }

    if (!args || typeof args.slot !== 'string' || args.slot.trim() === '') {
      throw new Error('slot is required (e.g. "Amulet" or "Belt")');
    }
    const focus = args.focus ?? 'both';
    const maxResults = args.max_results ?? 10;

    const result = await client.evaluateAnointCandidates({
      slot: args.slot,
      focus,
      // Pull a generous candidate set; we display max_results.
      limit: Math.max(maxResults, 50),
    });

    const lines: string[] = [
      `=== Best Anointment (slot: ${result.slot} / ${result.baseType}, focus: ${result.focus}) ===`,
      '',
      `Base without anoint ${getDpsMetric(result)}: ${formatNumber(getBaseDps(result))}  |  Base without anoint TotalEHP: ${formatNumber(result.base.TotalEHP)}`,
      ...formatCurrentAnoint(result),
      '',
      `Evaluated ${result.evaluated} anointable notables (${result.skipped} skipped), showing top ${Math.min(maxResults, result.candidates.length)}:`,
      '',
    ];

    const top = result.candidates.slice(0, maxResults);
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      lines.push(
        `${i + 1}. **${c.name}** [${c.nodeId}]`,
        ...formatCandidateDeltas(c, result),
        ...formatEffectLines('Candidate effect', c.statLines),
        ...formatSecondaryDeltas(c),
      );
      if (c.recipe && c.recipe.length > 0) {
        lines.push(`   Oils: ${c.recipe.join(' + ')}`);
      }
      lines.push('');
    }

    if (top.length === 0) {
      lines.push('No anointable candidates evaluated. Verify a build is loaded and the target slot has an anointable item.');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  });
}
