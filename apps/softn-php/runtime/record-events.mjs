import {constants} from 'node:sqlite';

// Installed only by the trusted host. TEMP triggers cannot enter an uploaded bundle.
export const RECORD_OUTBOX = '_formlogic_record_events';
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const hidden = /password|token|secret|code_hash|challenge|encrypted|sealed/i;

export function configureRecordEvents(db, subscriptions = []) {
  const trusted = new Set();
  if (!Array.isArray(subscriptions) || subscriptions.length > 100) throw new Error('Invalid record subscriptions');
  if (!subscriptions.length) return () => false;
  db.exec(`CREATE TABLE IF NOT EXISTS ${RECORD_OUTBOX}(id TEXT PRIMARY KEY,event_name TEXT NOT NULL,data_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,1)!='_' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
  for (const [index, subscription] of subscriptions.entries()) {
    const {event, bindings} = subscription;
    const match = /^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/.exec(event || '');
    if (!match || !Array.isArray(bindings) || !bindings.length || bindings.length > 100 || bindings.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('Invalid record subscription');
    const [, operation, table] = match;
    // A migration may remove a table while a paused/old binding still names it.
    if (!tables.has(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${identifier(table)})`).all()
      .filter(column => !hidden.test(column.name)).sort((a,b) => b.pk-a.pk).slice(0,40);
    const row = operation === 'deleted' ? 'OLD' : 'NEW';
    const pairs = columns.flatMap(column => {
      const value = `${row}.${identifier(column.name)}`;
      return [literal(column.name), `CASE WHEN typeof(${value})='blob' THEN NULL WHEN typeof(${value})='text' THEN substr(${value},1,400) ELSE ${value} END`];
    });
    const trigger = `_formlogic_capture_${index}`;
    const action = {created:'INSERT',updated:'UPDATE',deleted:'DELETE'}[operation];
    db.exec(`CREATE TEMP TRIGGER ${identifier(trigger)} AFTER ${action} ON main.${identifier(table)} BEGIN
      SELECT CASE WHEN (SELECT count(*) FROM ${RECORD_OUTBOX}) >= 10000 THEN RAISE(ABORT,'Record automation queue is full') END;
      INSERT INTO ${RECORD_OUTBOX}(id,event_name,data_json,bindings_json,created_at)
      VALUES(lower(hex(randomblob(16))),${literal(event)},json_object('table',${literal(table)},'operation',${literal(operation)},'record',json_object(${pairs.join(',')}),'recordPreview',json('true')),${literal(JSON.stringify(bindings))},unixepoch());
    END`);
    trusted.add(trigger);
  }
  // SQLite tells the authorizer which trigger caused the operation. Only our own
  // triggers may touch the outbox; ordinary guest queries retain their old policy.
  const functions = new Set(['count','raise','lower','hex','randomblob','json_object','json','typeof','substr','unixepoch']);
  return (action, table, column, database, source) => trusted.has(source) &&
    ((!database || database === 'main') &&
      (([constants.SQLITE_READ,constants.SQLITE_INSERT].includes(action) && table === RECORD_OUTBOX) ||
       (action === constants.SQLITE_FUNCTION && functions.has(String(column).toLowerCase()))));
}
