export const migration0013 = {
  version: 13,
  name: "p2p_top_level_category",
  sql: `
    UPDATE categories
    SET parent_id = NULL
    WHERE id = 'personal-p2p' AND code = 'p2p' AND scope = 'personal';
  `,
} as const;
