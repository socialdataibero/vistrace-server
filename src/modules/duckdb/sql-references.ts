export interface SqlReferences {
  tables: string[];
  forbidden: string[];
}

const ALLOWED_REF_TYPES = new Set(['BASE_TABLE', 'JOIN', 'SUBQUERY', 'EXPRESSION_LIST', 'EMPTY', 'PIVOT']);
const DEFAULT_SCHEMAS = new Set(['', 'main']);
const DEFAULT_CATALOGS = new Set(['', 'vistrace', 'memory']);

export function collectSqlReferences(serialized: string): SqlReferences {
  const parsed = JSON.parse(serialized) as { error?: boolean; error_message?: string; statements?: unknown[] };
  if (parsed.error) {
    return { tables: [], forbidden: [parsed.error_message ?? 'unparseable statement'] };
  }
  const tables = new Set<string>();
  const forbidden = new Set<string>();
  visit(parsed.statements ?? [], tables, forbidden);
  // CTE names are kept on purpose: a CTE named like a real table must not hide a reference to that table in another scope.
  return {
    tables: [...tables],
    forbidden: [...forbidden],
  };
}

function visit(value: unknown, tables: Set<string>, forbidden: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, tables, forbidden);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (isTableRef(node)) {
    const type = node['type'] as string;
    if (!ALLOWED_REF_TYPES.has(type)) {
      forbidden.add(refLabel(node));
    } else if (type === 'BASE_TABLE') {
      const schema = String(node['schema_name'] ?? '').toLowerCase();
      const catalog = String(node['catalog_name'] ?? '').toLowerCase();
      const name = String(node['table_name'] ?? '').toLowerCase();
      if (!DEFAULT_SCHEMAS.has(schema) || !DEFAULT_CATALOGS.has(catalog)) {
        forbidden.add([catalog, schema, name].filter(Boolean).join('.'));
      } else {
        tables.add(name);
      }
    }
  }
  for (const child of Object.values(node)) visit(child, tables, forbidden);
}

function isTableRef(node: Record<string, unknown>): boolean {
  return typeof node['type'] === 'string' && 'sample' in node && 'alias' in node && !('class' in node) && !('select_list' in node);
}

function refLabel(node: Record<string, unknown>): string {
  const fn = node['function'] as { function_name?: string } | undefined;
  return fn?.function_name ?? String(node['type']).toLowerCase();
}
