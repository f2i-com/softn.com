/**
 * Splitting a SQL script into its statements (sqliteDatabase.ts), which is
 * how a project's seed and migration files are run when Builder or Studio
 * opens its database.
 *
 * A trigger's body is BEGIN … END, with semicolons inside it, and the splitter
 * counted that END. It counted the END of a CASE expression inside the body
 * as the trigger's: the statement was cut at the next semicolon and the
 * engine was handed half a trigger and then a stray END. (The editors' XDB
 * engine refuses CREATE TRIGGER today, so for now this decides which error a
 * seed with one gives; an engine that runs triggers got a broken schema.)
 */
import { describe, expect, it } from 'vitest';
import { isMutatingSql, isReadOnlySql, splitSqlStatements } from '../src/sqliteDatabase';

describe('splitSqlStatements', () => {
  it('keeps a trigger whole when its body has a CASE expression', () => {
    const script = `
      CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL, band TEXT);
      CREATE TRIGGER orders_band AFTER INSERT ON orders BEGIN
        UPDATE orders SET band = CASE WHEN new.total > 100 THEN 'large' ELSE 'small' END WHERE id = new.id;
        UPDATE orders SET total = CASE new.total WHEN 0 THEN NULL ELSE new.total END WHERE id = new.id;
      END;
      INSERT INTO orders (total) VALUES (120);
    `;
    const statements = splitSqlStatements(script);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toMatch(/^CREATE TRIGGER orders_band/);
    expect(statements[1]).toMatch(/new\.total END WHERE id = new\.id;\s+END$/);
    expect(statements[2]).toBe('INSERT INTO orders (total) VALUES (120)');
  });

  it('keeps a trigger whole when its WHEN clause has a CASE expression', () => {
    const script = `CREATE TRIGGER t BEFORE UPDATE ON a WHEN CASE WHEN new.x > 0 THEN 1 ELSE 0 END BEGIN
        SELECT RAISE(ABORT, 'no; never');
      END;
      SELECT 1;`;
    const statements = splitSqlStatements(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/END$/);
    expect(statements[1]).toBe('SELECT 1');
  });

  it('still splits statements that use CASE outside any trigger', () => {
    expect(splitSqlStatements("SELECT CASE WHEN 1 THEN 'a' END; SELECT 'b;c'; SELECT casement FROM t")).toEqual([
      "SELECT CASE WHEN 1 THEN 'a' END",
      "SELECT 'b;c'",
      'SELECT casement FROM t',
    ]);
    expect(isReadOnlySql("SELECT CASE WHEN 1 THEN 'a' END; SELECT 2")).toBe(true);
    expect(isMutatingSql("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN 1 THEN 2 END; END;")).toBe(true);
  });
});
