export const migration0005 = {
  version: 5,
  name: "import_status_partition",
  sql: `
    ALTER TABLE import_batches
      ADD COLUMN non_posted_count INTEGER NOT NULL DEFAULT 0 CHECK (non_posted_count >= 0);

    UPDATE import_batches
    SET non_posted_count = (
      SELECT count(*) FROM source_records sr
      WHERE sr.batch_id = import_batches.id AND sr.row_state = 'non_posted'
    );
  `,
} as const;
