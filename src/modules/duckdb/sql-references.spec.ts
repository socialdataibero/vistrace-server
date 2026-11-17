import * as duckdb from 'duckdb';
import { collectSqlReferences } from './sql-references';

describe('collectSqlReferences', () => {
  const db = new duckdb.Database(':memory:');
  const conn = db.connect();

  afterAll(() => db.close());

  function serialize(sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      conn.all(`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}') AS j`, (err, rows) => {
        if (err) reject(err);
        else resolve(String(rows[0]['j']));
      });
    });
  }

  async function refs(sql: string) {
    return collectSqlReferences(await serialize(sql));
  }

  it('lists tables from joins, subqueries and CTE bodies, without the CTE names', async () => {
    const r = await refs('WITH x AS (SELECT * FROM a) SELECT * FROM x JOIN b USING (id) WHERE id IN (SELECT id FROM c)');
    expect(r.tables.sort()).toEqual(['a', 'b', 'c']);
    expect(r.forbidden).toEqual([]);
  });

  it('lower-cases quoted table names', async () => {
    expect((await refs('SELECT * FROM "Censo_Parquet"')).tables).toEqual(['censo_parquet']);
  });

  it('forbids table functions that read files or the catalog', async () => {
    expect((await refs("SELECT * FROM read_parquet('uploads/x.parquet')")).forbidden).toEqual(['read_parquet']);
    expect((await refs('SELECT * FROM duckdb_tables()')).forbidden).toEqual(['duckdb_tables']);
    expect((await refs("SELECT * FROM a JOIN read_csv('f.csv') USING (id)")).forbidden).toEqual(['read_csv']);
  });

  it('forbids other schemas and catalogs', async () => {
    expect((await refs('SELECT * FROM information_schema.tables')).forbidden).toEqual(['information_schema.tables']);
  });

  it('forbids SHOW and anything that is not a single SELECT', async () => {
    expect((await refs('SHOW TABLES')).forbidden.length).toBeGreaterThan(0);
    expect((await refs('DROP TABLE a')).forbidden.length).toBeGreaterThan(0);
    expect((await refs('SELECT 1; DROP TABLE a')).forbidden.length).toBeGreaterThan(0);
  });

  it('allows VALUES and constant selects', async () => {
    expect(await refs('SELECT 1 AS n')).toEqual({ tables: [], forbidden: [] });
    expect((await refs('SELECT * FROM (VALUES (1), (2)) t(n)')).forbidden).toEqual([]);
  });
});
