// Evidence storage: licensed and provider research rows, Open Prices
// observations, display permissions, import runs and the lookup cache.
import {
  RESEARCH_TABLE,
  RESEARCH_COLUMNS,
  RESEARCH_TYPES,
  OBSERVATIONS_TABLE,
  OBSERVATION_COLUMNS,
  OBSERVATION_TYPES,
  PERMISSIONS_TABLE,
  addMissingColumns,
} from "./contract.mjs";

export function schema(db) {
  db.exec(RESEARCH_TABLE);
  addMissingColumns(db, "research", RESEARCH_COLUMNS, RESEARCH_TYPES);
  db.exec(OBSERVATIONS_TABLE);
  addMissingColumns(db, "observations", OBSERVATION_COLUMNS, OBSERVATION_TYPES);
  db.exec(`UPDATE research SET first_imported = imported WHERE first_imported IS NULL;
UPDATE observations SET imported = COALESCE(imported, CURRENT_TIMESTAMP) WHERE imported IS NULL;
UPDATE observations SET first_imported = imported WHERE first_imported IS NULL;`);
  db.exec(PERMISSIONS_TABLE);
}
