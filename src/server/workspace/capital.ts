import type { CapitalPosition } from '@/server/read-model/finance-centers';

const foreignProviders = new Set(['erste', 'wise', 'revolut', 'zen']);

/** Workspace savings scope; Ukrainian operating accounts remain in the full ledger. */
export function includeWorkspacePosition(position: CapitalPosition): boolean {
  return position.scope === 'PERSONAL' && (foreignProviders.has(position.providerCode)
    || position.type === 'cash' || position.manualEvidence?.kind === 'cash');
}
