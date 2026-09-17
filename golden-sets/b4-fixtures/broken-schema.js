/**
 * B4 fixture — deliberately broken Cube schema
 * References SCHEMA_VERSION which is not defined in the VM context.
 * Expected: ReferenceError at compile time → b4-ci-gate exits 1 (pipeline blocked).
 */
cube('partner_survey', {
  sql: `SELECT * FROM ${CUBE}.${SCHEMA_VERSION}_responses`,

  measures: {
    response_count: {
      type: `count`,
      title: `Total Responses`,
    },
  },

  dimensions: {
    respondent_id: {
      sql: `${CUBE}.uuid`,
      type: `string`,
      primaryKey: true,
    },
  },
});
