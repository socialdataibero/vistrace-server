import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as duckdb from 'duckdb';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { feature as topoFeature } from 'topojson-client';
import { assertEmbeddableSql } from '../query/read-only-sql';
import { iberoApiUrl } from '../ibero/ibero-api-url';
import { collectSqlReferences } from './sql-references';
import { isPublicVisitor, PUBLIC_VISITOR_SWEEP_MS, PUBLIC_VISITOR_TTL_MS } from '../../shared/auth/public-visitor';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  role?: 'geometry' | 'latitude' | 'longitude' | 'join_key';
}

function isNumericType(type: string): boolean {
  return /int|decimal|double|float|real|numeric|number|hugeint|bigint|smallint|tinyint|uinteger|ubigint|usmallint|utinyint/i.test(type);
}

function normalizeIdText(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalizeToken(token: string): string {
  if (/^(lat|latitude)$/.test(token)) return 'lat';
  if (/^(lon|lng|long|longitude)$/.test(token)) return 'lon';
  return token;
}

function tokenizeIdentifier(name: string): string[] {
  return normalizeIdText(name).split(/\s+/).filter(Boolean).map(canonicalizeToken);
}

export function inferColumnRole(name: string, type: string): ColumnInfo['role'] | undefined {
  const normalizedName = normalizeIdText(name);
  const tokens = tokenizeIdentifier(name);

  if (/(^| )(geometry|geom|geojson|topojson|shape)( |$)/.test(normalizedName)) return 'geometry';
  if (isNumericType(type) && tokens.includes('lat')) return 'latitude';
  if (isNumericType(type) && tokens.includes('lon')) return 'longitude';
  if (tokens.includes('name') || tokens.includes('code') || tokens.includes('cve') || tokens.includes('cod') || /(^| )(id|key)( |$)/.test(normalizedName)) return 'join_key';
  return undefined;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  totalRows: number;
  sql: string;
}

export interface TableMeta {
  fileSize?: number;
  fileType?: string;
  originalName?: string;
  sourceUrl?: string;
  storedFile?: string;
  createdAt?: number;
  owners?: string[];
}

@Injectable()
export class DuckdbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DuckdbService.name);
  private db: duckdb.Database;
  private conn: duckdb.Connection;

  private readonly dataDir = path.join(process.cwd(), 'data');
  private readonly dbPath = path.join(process.cwd(), 'data', 'vistrace.db');
  private readonly metaPath = path.join(process.cwd(), 'data', 'meta.json');
  private tableMeta = new Map<string, TableMeta>();
  // Lower-cased table names handed out but maybe not created yet, so two concurrent uploads never get the same name.
  // shortcut: never released (a failed load keeps its name until restart), fine while names stay few.
  private readonly reservedNames = new Map<string, string | undefined>();

  async onModuleInit(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.adoptLegacyDatabase();
    this.db = new duckdb.Database(this.dbPath);
    this.conn = this.db.connect();
    this.tableMeta = this.loadMeta();
    this.logger.log(`DuckDB inicializado con persistencia en ${this.dbPath}`);
    await this.lockDownDatabase();
    setInterval(() => void this.dropExpiredVisitorTables(), PUBLIC_VISITOR_SWEEP_MS).unref();
  }

  async dropExpiredVisitorTables(now = Date.now()): Promise<string[]> {
    const expired = [...this.tableMeta.entries()]
      .filter(([, m]) => (m.owners ?? []).length > 0 && m.owners!.every(isPublicVisitor))
      .filter(([, m]) => now - (m.createdAt ?? 0) > PUBLIC_VISITOR_TTL_MS)
      .map(([name]) => name);
    for (const name of expired) {
      await this.runAsync(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
      const storedFile = this.tableMeta.get(name)?.storedFile;
      this.tableMeta.delete(name);
      this.reservedNames.delete(name.toLowerCase());
      this.removeStoredFileIfUnused(storedFile);
    }
    if (expired.length > 0) this.saveMeta();
    return expired;
  }

  // Servers deployed before the rename to vistrace keep their tables in data/vizcanvas.db.
  private adoptLegacyDatabase(): void {
    const legacyPath = path.join(this.dataDir, 'vizcanvas.db');
    if (fs.existsSync(this.dbPath) || !fs.existsSync(legacyPath)) return;
    fs.renameSync(legacyPath, this.dbPath);
    if (fs.existsSync(`${legacyPath}.wal`)) fs.renameSync(`${legacyPath}.wal`, `${this.dbPath}.wal`);
    this.logger.log(`Renamed legacy database ${legacyPath} to ${this.dbPath}`);
  }

  private async lockDownDatabase(): Promise<void> {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const safeUploads = uploadsDir.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      await this.runAsync(`SET allowed_directories = ['${safeUploads}']`);
      await this.runAsync(`SET enable_external_access = false`);
      await this.runAsync(`SET lock_configuration = true`);
      this.logger.log(`DuckDB sandbox ${uploadsDir}`);
    } catch (err) {
      this.logger.warn(`cannot set sandbox: ${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.conn?.close();
    this.db?.close();
  }

  private loadMeta(): Map<string, TableMeta> {
    try {
      const raw = fs.readFileSync(this.metaPath, 'utf-8');
      return new Map(Object.entries(JSON.parse(raw) as Record<string, TableMeta>));
    } catch {
      return new Map();
    }
  }

  private saveMeta(): void {
    // Write then rename: a crash mid-write must not leave a truncated meta.json that drops every owner.
    const tmp = `${this.metaPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.tableMeta), null, 2));
    fs.renameSync(tmp, this.metaPath);
  }

  private runAsync(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.run(sql, (err) =>
        err ? reject(new BadRequestException(err.message)) : resolve(),
      );
    });
  }

  private allAsync(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, rows) =>
        err
          ? reject(new BadRequestException(err.message))
          : resolve((rows ?? []) as Record<string, unknown>[]),
      );
    });
  }

  private convertRow(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, this.convertValue(v)]),
    );
  }

  private convertValue(val: unknown): unknown {
    if (val === null || val === undefined) return null;
    if (typeof val === 'bigint') return Number(val);
    return val;
  }

  private async describeQuery(sql: string): Promise<ColumnInfo[]> {
    try {
      const rows = await this.allAsync(`DESCRIBE (${sql})`);
      return rows.map((r) => {
        const name = String(r['column_name']);
        const type = String(r['column_type']);
        const col: ColumnInfo = { name, type, nullable: r['null'] !== 'NO' };
        const role = inferColumnRole(name, type);
        if (role) col.role = role;
        return col;
      });
    } catch {
      return [];
    }
  }

  private async describeTable(tableName: string): Promise<ColumnInfo[]> {
    const safe = tableName.replace(/"/g, '""');
    const rows = await this.allAsync(`DESCRIBE "${safe}"`);
    return rows.map((r) => {
      const name = String(r['column_name']);
      const type = String(r['column_type']);
      const col: ColumnInfo = { name, type, nullable: r['null'] !== 'NO' };
      const role = inferColumnRole(name, type);
      if (role) col.role = role;
      return col;
    });
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const [columns, rawRows] = await Promise.all([
      this.describeQuery(sql),
      this.allAsync(sql),
    ]);
    const rows = rawRows.map((r) => this.convertRow(r));
    const finalColumns = columns.length
      ? columns
      : this.inferColumns(rows);
    return { columns: finalColumns, rows, totalRows: rows.length, sql };
  }

  async executeQueryLimited(sql: string, limit = 250): Promise<QueryResult> {
    // A final semicolon is valid in a statement but not inside the subquery below.
    sql = sql.replace(/;\s*$/, '');
    const limitedSql = `SELECT * FROM (${sql}) AS _q LIMIT ${limit}`;
    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS _q`;

    const [columns, rawRows, countRows] = await Promise.all([
      this.describeQuery(sql),
      this.allAsync(limitedSql),
      this.allAsync(countSql).catch(() => [{ total: 0 }]),
    ]);

    const rows = rawRows.map((r) => this.convertRow(r));
    const finalColumns = columns.length ? columns : this.inferColumns(rows);
    const totalRows = Number(countRows[0]?.['total'] ?? rows.length);

    return { columns: finalColumns, rows, totalRows, sql };
  }

  private inferColumns(rows: Record<string, unknown>[]): ColumnInfo[] {
    if (!rows.length) return [];
    return Object.keys(rows[0]).map((name) => {
      const sample = rows.find((r) => r[name] !== null)?.[name];
      return { name, type: this.inferType(sample), nullable: true };
    });
  }

  private inferType(val: unknown): string {
    if (val instanceof Date) return 'TIMESTAMP';
    if (typeof val === 'boolean') return 'BOOLEAN';
    if (typeof val === 'bigint') return 'BIGINT';
    if (typeof val === 'number') return Number.isInteger(val) ? 'INTEGER' : 'DOUBLE';
    return 'VARCHAR';
  }

  async getTableSchema(tableName: string): Promise<ColumnInfo[]> {
    return this.describeTable(tableName);
  }

  async getTables(): Promise<string[]> {
    const rows = await this.allAsync(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
    );
    return rows.map((r) => String(r['table_name']));
  }

  private isVisibleTo(tableName: string, username?: string): boolean {
    if (!username) return true;
    const owners = this.tableMeta.get(tableName)?.owners;
    return !!owners?.includes(username);
  }

  async assertQueryAccess(sql: string, username: string): Promise<void> {
    const literal = sql.replace(/'/g, "''");
    const rows = await this.allAsync(`SELECT json_serialize_sql('${literal}') AS j`);
    const refs = collectSqlReferences(String(rows[0]?.['j'] ?? '{"error":true}'));
    if (refs.forbidden.length > 0) {
      throw new BadRequestException(`Consulta no permitida: ${refs.forbidden.join(', ')}`);
    }
    const existing = new Map((await this.getTables()).map((t) => [t.toLowerCase(), t]));
    for (const name of refs.tables) {
      const table = existing.get(name);
      if (table && !this.isVisibleTo(table, username)) {
        throw new ForbiddenException(`No tienes acceso a la tabla ${table}`);
      }
    }
  }

  async assertOwnsTable(tableName: string, username: string): Promise<void> {
    const tables = await this.getTables();
    if (!tables.includes(tableName) || !this.isVisibleTo(tableName, username)) {
      throw new NotFoundException(`Tabla no encontrada: ${tableName}`);
    }
  }

  async assertCanReplace(tableName: string, username: string): Promise<void> {
    const key = tableName.toLowerCase();
    // DuckDB names are case-insensitive: "Datos" and "datos" are the same table.
    const existing = (await this.getTables()).find((t) => t.toLowerCase() === key);
    if (!existing) {
      if (this.reservedNames.has(key) && this.reservedNames.get(key) !== username) {
        throw new ConflictException(`El nombre de tabla ${tableName} ya está en uso`);
      }
      this.reservedNames.set(key, username);
      return;
    }
    const owners = this.tableMeta.get(existing)?.owners ?? [];
    if (existing !== tableName || owners.length !== 1 || owners[0] !== username) {
      throw new ConflictException(`El nombre de tabla ${tableName} ya está en uso`);
    }
  }

  storedFilesOf(username: string): string[] {
    return [...this.tableMeta.values()]
      .filter((m) => m.storedFile && m.owners?.includes(username))
      .map((m) => m.storedFile as string);
  }

  tablesForStoredFile(storedFile: string, username?: string): string[] {
    return [...this.tableMeta.entries()]
      .filter(([, m]) => m.storedFile === storedFile && (!username || m.owners?.includes(username)))
      .map(([name]) => name);
  }

  async getTablesWithMeta(username?: string): Promise<
    Array<{ name: string; columns: ColumnInfo[]; rowCount: number; fileSize?: number; fileType?: string }>
  > {
    const names = (await this.getTables()).filter((name) => this.isVisibleTo(name, username));
    return Promise.all(
      names.map(async (name) => {
        const safe = name.replace(/"/g, '""');
        const [columns, countRows] = await Promise.all([
          this.describeTable(name),
          this.allAsync(`SELECT COUNT(*) AS cnt FROM "${safe}"`),
        ]);
        const meta = this.tableMeta.get(name) ?? {};
        return {
          name,
          columns,
          rowCount: Number(countRows[0]?.['cnt'] ?? 0),
          fileSize: meta.fileSize,
          fileType: meta.fileType,
        };
      }),
    );
  }

  private reusableIberoTable(sourceUrl: string, username?: string): string | null {
    if (!username) return null;
    const match = [...this.tableMeta.entries()].find(
      ([, m]) => m.sourceUrl === sourceUrl && m.owners?.length === 1 && m.owners[0] === username,
    );
    return match?.[0] ?? null;
  }

  async resolveTableName(baseName: string, username?: string): Promise<string> {
    const existing = new Set((await this.getTables()).map((t) => t.toLowerCase()));
    // No await below: checking and reserving the name happen in one step.
    let name = baseName;
    let suffix = 1;
    while (existing.has(name.toLowerCase()) || this.reservedNames.has(name.toLowerCase())) {
      name = `${baseName}_${suffix}`;
      suffix++;
    }
    this.reservedNames.set(name.toLowerCase(), username);
    return name;
  }

  async loadFileFromDisk(
    filePath: string,
    tableName: string,
    ext: string,
    meta?: TableMeta,
  ): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
    if (ext === 'geojson' || ext === 'topojson') {
      return this.loadGeoFile(filePath, tableName, ext, meta);
    }

    const safe = tableName.replace(/"/g, '""');
    const safePath = filePath.replace(/\\/g, '/').replace(/'/g, "''");
    let sql: string;

    switch (ext) {
      case 'csv':
      case 'tsv':
        sql = `CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_csv('${safePath}', auto_detect=true, header=true)`;
        break;
      case 'parquet':
        sql = `CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_parquet('${safePath}')`;
        break;
      case 'json':
      case 'jsonl':
        sql = `CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_json('${safePath}', auto_detect=true)`;
        break;
      default:
        throw new Error(`Tipo de archivo no soportado: .${ext}`);
    }

    await this.runAsync(sql);

    const [columns, countRows] = await Promise.all([
      this.describeTable(tableName),
      this.allAsync(`SELECT COUNT(*) AS cnt FROM "${safe}"`),
    ]);

    if (meta) { this.tableMeta.set(tableName, meta); this.saveMeta(); }

    return { columns, rowCount: Number(countRows[0]?.['cnt'] ?? 0) };
  }

  private async loadGeoFile(
    filePath: string,
    tableName: string,
    ext: string,
    meta?: TableMeta,
  ): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const { rows, columns } = normalizeGeoData(parsed, ext);
    return this.importTableData(tableName, rows, columns, meta);
  }

  async dropTable(tableName: string, username?: string): Promise<void> {
    if (!this.isVisibleTo(tableName, username)) {
      throw new NotFoundException(`Tabla no encontrada: ${tableName}`);
    }
    const owners = this.tableMeta.get(tableName)?.owners ?? [];
    if (username && owners.length > 1) {
      const meta = this.tableMeta.get(tableName)!;
      this.tableMeta.set(tableName, { ...meta, owners: owners.filter((o) => o !== username) });
      this.saveMeta();
      return;
    }
    const safe = tableName.replace(/"/g, '""');
    await this.runAsync(`DROP TABLE IF EXISTS "${safe}"`);
    const storedFile = this.tableMeta.get(tableName)?.storedFile;
    this.tableMeta.delete(tableName);
    this.reservedNames.delete(tableName.toLowerCase());
    this.saveMeta();
    this.removeStoredFileIfUnused(storedFile);
  }

  // The uploaded file is only the source of its tables: once none of them is left it is dead weight on disk.
  private removeStoredFileIfUnused(storedFile?: string): void {
    if (!storedFile || this.tablesForStoredFile(storedFile).length > 0) return;
    fs.rmSync(path.join(process.cwd(), 'uploads', path.basename(storedFile)), { force: true });
  }

  async clearAllTables(username?: string): Promise<void> {
    const names = (await this.getTables()).filter((name) => {
      if (!username) return true;
      const owners = this.tableMeta.get(name)?.owners ?? [];
      return owners.includes(username);
    });
    for (const name of names) {
      await this.dropTable(name, username);
    }
  }

  async exportQueryToParquet(sql: string): Promise<Buffer> {
    assertEmbeddableSql(sql);
    const tmpPath = path.join(process.cwd(), 'uploads', `__publish_${Date.now()}_${Math.random().toString(36).slice(2)}.parquet`);
    const safeTmp = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      await this.runAsync(`COPY (${sql}\n) TO '${safeTmp}' (FORMAT PARQUET)`);
      return fs.readFileSync(tmpPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  }

  private static readonly INLINE_ROW_LIMIT = 100_000;

  async exportTableData(tableName: string): Promise<{
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];
    rowCount: number;
    dataEmbedded: boolean;
  }> {
    const safe = tableName.replace(/"/g, '""');
    const [columns, countRows] = await Promise.all([
      this.describeTable(tableName),
      this.allAsync(`SELECT COUNT(*) AS cnt FROM "${safe}"`),
    ]);
    const total = Number(countRows[0]?.['cnt'] ?? 0);

    if (total > DuckdbService.INLINE_ROW_LIMIT) {
      this.logger.warn(`exportTableData: "${tableName}" has ${total} rows — skipping inline embed`);
      return { columns, rows: [], rowCount: total, dataEmbedded: false };
    }

    const tmpPath = path.join(process.cwd(), 'uploads', `__export_${randomUUID()}.ndjson`);
    const safeTmp = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      await this.runAsync(`COPY "${safe}" TO '${safeTmp}' (FORMAT JSON)`);
      const rows: Record<string, unknown>[] = [];
      const rl = readline.createInterface({ input: fs.createReadStream(tmpPath), crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.trim()) rows.push(this.convertRow(JSON.parse(line) as Record<string, unknown>));
      }
      return { columns, rows, rowCount: rows.length, dataEmbedded: true };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already deleted */ }
    }
  }

  async importTableData(
    tableName: string,
    rows: Record<string, unknown>[],
    columns: ColumnInfo[],
    meta?: TableMeta,
  ): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
    const safe = tableName.replace(/"/g, '""');
    // CREATE OR REPLACE only: if the new data fails to load, the old table is kept.
    if (rows.length === 0) {
      const colDefs = columns
        .map((c) => `"${c.name.replace(/"/g, '""')}" ${normalizeDuckDBType(c.type)}`)
        .join(', ');
      await this.runAsync(`CREATE OR REPLACE TABLE "${safe}" (${colDefs})`);
    } else {
      const tmpPath = path.join(process.cwd(), 'uploads', `__tmp_${randomUUID()}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(rows));
      try {
        const safeTmp = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");
        await this.runAsync(
          `CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_json('${safeTmp}', auto_detect=true)`,
        );
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }

    const [schema, countRows] = await Promise.all([
      this.describeTable(tableName),
      this.allAsync(`SELECT COUNT(*) AS cnt FROM "${safe}"`),
    ]);

    if (meta) { this.tableMeta.set(tableName, meta); this.saveMeta(); }

    return { columns: schema, rowCount: Number(countRows[0]?.['cnt'] ?? 0) };
  }

  /**
   * Only files served by the configured Ibero Data API can be imported: the
   * server fetches the URL itself and forwards the download token to it.
   */
  private assertIberoUrl(url: string): void {
    const base = iberoApiUrl();
    if (!base) throw new BadRequestException('IBERO_API_URL is not configured');
    if (!url.startsWith(`${base}/`)) throw new BadRequestException('Only Ibero Data files can be imported');
  }

  async importFromUrl(url: string, rawName: string, format: string, downloadToken?: string, username?: string): Promise<{ tableName: string; rowCount: number }> {
    const baseName = (rawName.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 60) || 'ibero_data');
    this.assertIberoUrl(url);
    const sourceUrl = url.split('?')[0];
    const tableName = this.reusableIberoTable(sourceUrl, username) ?? (await this.resolveTableName(baseName, username));

    const urlExt = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    const resolvedFormat = urlExt === 'parquet' ? 'parquet' : (format === 'parquet' ? 'parquet' : 'csv');
    const ext = resolvedFormat === 'parquet' ? 'parquet' : 'csv';
    const tmpPath = path.join(process.cwd(), 'uploads', `__ibero_${randomUUID()}.${ext}`);

    const headers: Record<string, string> = {};
    if (downloadToken) headers['Authorization'] = downloadToken;

    const res = await fetch(url, { headers });
    this.logger.log(`[importFromUrl] status=${res.status} content-type=${res.headers.get('content-type')} url=${url}`);
    if (!res.ok) throw new BadRequestException(`cannot download the file from Ibero Data: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.join(process.cwd(), 'uploads'), { recursive: true });
    fs.writeFileSync(tmpPath, buffer);

    const safe = tableName.replace(/"/g, '""');
    const safeTmp = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");

    try {
      if (resolvedFormat === 'parquet') {
        await this.runAsync(`CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_parquet('${safeTmp}')`);
      } else {
        await this.runAsync(`CREATE OR REPLACE TABLE "${safe}" AS SELECT * FROM read_csv('${safeTmp}', auto_detect=true, header=true)`);
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    const countRows = await this.allAsync(`SELECT COUNT(*) AS cnt FROM "${safe}"`);
    const rowCount = Number(countRows[0]?.['cnt'] ?? 0);
    this.tableMeta.set(tableName, {
      createdAt: Date.now(),
      fileType: resolvedFormat,
      originalName: rawName,
      sourceUrl,
      ...(username ? { owners: [username] } : {}),
    });
    this.saveMeta();
    return { tableName, rowCount };
  }
}

export function normalizeDuckDBType(type: string): string {
  const t = (type ?? '').trim().toUpperCase();
  if (/^DATE/.test(t)) return 'DATE';
  if (/^TIMESTAMP/.test(t)) return 'TIMESTAMP';
  if (/^(VARCHAR|TEXT|STRING|UUID)/.test(t)) return 'VARCHAR';
  if (/^BOOL/.test(t)) return 'BOOLEAN';
  if (/^(FLOAT64|DOUBLE|REAL)/.test(t)) return 'DOUBLE';
  if (/^FLOAT/.test(t)) return 'FLOAT';
  if (/^(INT64|BIGINT|HUGEINT)/.test(t)) return 'BIGINT';
  if (/^(INT32|INTEGER|INT)/.test(t)) return 'INTEGER';
  if (/^(INT16|SMALLINT)/.test(t)) return 'SMALLINT';
  if (/^(INT8|TINYINT)/.test(t)) return 'TINYINT';
  if (/^(UINT64|UBIGINT)/.test(t)) return 'UBIGINT';
  if (/^(UINT32|UINTEGER)/.test(t)) return 'UINTEGER';
  // The type string comes from the client and goes into DDL, so only an exact DECIMAL(p[,s]) passes through.
  const decimal = /^(?:DECIMAL|NUMERIC)\s*\(\s*(\d{1,2})\s*(?:,\s*(\d{1,2})\s*)?\)$/.exec(t);
  if (decimal) return `DECIMAL(${decimal[1]}${decimal[2] !== undefined ? `,${decimal[2]}` : ''})`;
  if (/^(DECIMAL|NUMERIC)/.test(t)) return 'DOUBLE';
  if (/^(JSON|STRUCT|MAP|LIST|ARRAY)/.test(t)) return 'JSON';
  if (/^(BLOB|BINARY)/.test(t)) return 'BLOB';
  return 'VARCHAR';
}

type GeoFeature = {
  type?: string;
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
  };

function normalizeGeoData(
  parsed: unknown,
  ext: string,
): { rows: Record<string, unknown>[]; columns: ColumnInfo[] } {
  let features: GeoFeature[] = [];
  const obj = parsed as Record<string, unknown>;

  if (ext === 'topojson' && obj?.type === 'Topology') {
    const objects = (obj.objects ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(objects)) {
      try {
        const geojson = topoFeature(parsed as Parameters<typeof topoFeature>[0], objects[key] as Parameters<typeof topoFeature>[1]);
        const fc = geojson as { type: string; features?: GeoFeature[] };
        if (fc.type === 'FeatureCollection' && Array.isArray(fc.features)) {
          features = features.concat(fc.features as GeoFeature[]);
        } else {
          features.push(fc as GeoFeature);
        }
      } catch {
        // skip invalid objects
      }
    }
  } else if (obj?.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    features = obj.features as GeoFeature[];
  } else if (obj?.type === 'Feature') {
    features = [obj as GeoFeature];
  }

  if (!features.length) return { rows: [], columns: [] };

  const rows = features.map((f) => ({
    ...(f.properties ?? {}),
    geometry: f.geometry ? JSON.stringify(f.geometry) : null,
  }));

  const firstRow = rows[0] ?? {};
  const columns: ColumnInfo[] = Object.keys(firstRow).map((name) => ({
    name,
    type: name === 'geometry' ? 'VARCHAR' : inferJsType(firstRow[name]),
    nullable: true,
  }));

  return { rows, columns };
}

function inferJsType(val: unknown): string {
  if (typeof val === 'number') return Number.isInteger(val) ? 'INTEGER' : 'DOUBLE';
  if (typeof val === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}
