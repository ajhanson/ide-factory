import {
  applyPlan,
  planAdapters,
  stageConflicts,
} from './adapters.mjs';

export const EXIT_CONFLICTS = 3;

const STATUS_ORDER = ['current', 'update', 'create', 'modified', 'preserved', 'pinned', 'malformed', 'orphan'];

function emptyCounts() {
  const counts = {};
  for (const status of STATUS_ORDER) counts[status] = 0;
  return counts;
}

function buildReport(plan, staged, command) {
  const summary = emptyCounts();
  const files = plan.files.map((item) => {
    summary[item.status] += 1;
    const entry = { path: item.key, status: item.status, digest: item.rendering };
    const saved = staged && staged.files.get(item.key);
    if (saved) {
      entry.incoming = saved.incoming;
      if (saved.diff) entry.diff = saved.diff;
    }
    if (item.reason) entry.reason = item.reason;
    if (item.status === 'pinned' && item.upstreamChanged) entry.upstreamChanged = true;
    return entry;
  });
  summary.orphan = plan.orphans.length;
  const orphans = plan.orphans.map((item) => ({ path: item.path, source: item.source }));
  const exitCode = summary.preserved + summary.malformed > 0 ? EXIT_CONFLICTS : 0;
  return {
    version: 1,
    command,
    summary,
    run: staged ? staged.rel : null,
    files,
    orphans,
    exitCode,
  };
}

/**
 * Plan, stage, and apply the generated adapter files and instruction sections.
 * @param {string} project
 * @param {{ command?: string, now?: Date }} [options]
 */
export function syncAdapters(project, options = {}) {
  const command = options.command || 'upgrade';
  const plan = planAdapters(project);
  const staged = stageConflicts(project, plan, { now: options.now });
  const result = applyPlan(project, plan);
  const report = buildReport(plan, staged, command);
  return { plan, staged, result, report };
}

/** Human-readable report lines. */
export function formatReport(report) {
  const { summary } = report;
  const lines = [
    `${report.command}: ${STATUS_ORDER.map((status) => `${summary[status]} ${status}`).join(', ')}`,
  ];
  for (const file of report.files) {
    if (file.status === 'current') continue;
    const reason = file.reason ? `: ${file.reason}` : '';
    const note = file.upstreamChanged ? ' (upstream changed since pin)' : '';
    lines.push(`  ${file.status.padEnd(9)} ${file.path}${reason}${note}`);
    if (file.incoming) lines.push(`    incoming: ${file.incoming}`);
    if (file.diff) lines.push(`    diff:     ${file.diff}`);
  }
  for (const orphan of report.orphans) {
    lines.push(`  ${'orphan'.padEnd(9)} ${orphan.path} (a past release generated this path; left in place)`);
  }
  if (summary.preserved > 0) {
    lines.push(
      'Resolve with: idefactory adapters pin <path> | idefactory upgrade --replace <path> | edit the file, then run upgrade again.',
    );
  }
  if (summary.malformed > 0) {
    lines.push('Repair the instruction file markers by hand, then run upgrade again.');
  }
  return lines;
}
