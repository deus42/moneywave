export interface AutonomousAnalysisStages<Undated, Repair, ProviderFx, Preparation, Movements, Reconciliation, Costs, Classification, Categorization> {
  recoverUndated(): Promise<Undated>;
  repairAutomaticFx(): Promise<Repair>;
  materializeProviderFx(): Promise<ProviderFx>;
  prepareClassifications(): Promise<Preparation>;
  discoverMovements(): Promise<Movements>;
  reconcileMovements(): Promise<Reconciliation>;
  analyzeCosts(): Promise<Costs>;
  classifyEntries(): Promise<Classification>;
  categorizePersonalEntries(): Promise<Categorization>;
}

export async function runAutonomousAnalysis<Undated, Repair, ProviderFx, Preparation, Movements, Reconciliation, Costs, Classification, Categorization>(
  stages: AutonomousAnalysisStages<Undated, Repair, ProviderFx, Preparation, Movements, Reconciliation, Costs, Classification, Categorization>,
): Promise<{
  undated: Undated;
  repair: Repair;
  providerFx: ProviderFx;
  preparation: Preparation;
  movements: Movements;
  reconciliation: Reconciliation;
  costs: Costs;
  classification: Classification;
  categorization: Categorization;
}> {
  const undated = await stages.recoverUndated();
  const repair = await stages.repairAutomaticFx();
  const providerFx = await stages.materializeProviderFx();
  const preparation = await stages.prepareClassifications();
  const movements = await stages.discoverMovements();
  const reconciliation = await stages.reconcileMovements();
  const costs = await stages.analyzeCosts();
  const classification = await stages.classifyEntries();
  const categorization = await stages.categorizePersonalEntries();
  return { undated, repair, providerFx, preparation, movements, reconciliation, costs, classification, categorization };
}
