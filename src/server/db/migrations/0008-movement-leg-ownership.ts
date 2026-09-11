export const migration0008 = {
  version: 8,
  name: "movement_leg_ownership",
  sql: `
    CREATE UNIQUE INDEX movement_legs_one_group_per_entry
      ON movement_legs(ledger_entry_id);
  `,
} as const;
