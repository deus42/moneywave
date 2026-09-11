export const migration0010 = {
  version: 10,
  name: "external_personal_transfers",
  sql: `
    INSERT INTO categories (id, parent_id, scope, code, display_name, editable)
    VALUES ('personal-p2p', 'personal-other', 'personal', 'p2p', 'Перекази людям', 1);

    UPDATE categories
    SET display_name = 'Комунальні та звʼязок'
    WHERE code = 'utilities';
  `,
} as const;
