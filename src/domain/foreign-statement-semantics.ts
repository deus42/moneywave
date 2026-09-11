/** Provider facts describe a movement shape; "transfer" does not prove ownership. */
export function foreignStatementCategory(provider: string, metadata: Record<string, unknown>, direction: string, description: string): string | null {
  if (provider === 'wise') {
    if (metadata.detailsType === 'CARD' && direction === 'credit' && /^received\b.{0,160}\bfrom\b/iu.test(description.trim())) return 'transfer';
    if (metadata.detailsType === 'CONVERSION') return 'currency exchange';
    if (['TRANSFER', 'DEPOSIT', 'MONEY_ADDED'].includes(String(metadata.detailsType))) return 'transfer';
  }
  if (provider === 'revolut') {
    if (metadata.providerType === 'Exchange') return 'currency exchange';
    if (['Transfer', 'Deposit', 'CARD_CREDIT'].includes(String(metadata.providerType))) return 'transfer';
    if (metadata.providerType === 'ATM' && direction === 'debit') return 'cash withdrawal';
  }
  if (provider === 'erste' && direction === 'debit' && /\bnaknad[aeu]\b/iu.test(description)) return 'bank_fee';
  return null;
}
