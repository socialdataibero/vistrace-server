import { normalizeDuckDBType } from './duckdb.service';

describe('normalizeDuckDBType', () => {
  it('keeps a well-formed DECIMAL', () => {
    expect(normalizeDuckDBType('decimal(10, 2)')).toBe('DECIMAL(10,2)');
    expect(normalizeDuckDBType('NUMERIC(8)')).toBe('DECIMAL(8)');
  });

  it('never passes extra SQL through a DECIMAL type', () => {
    expect(normalizeDuckDBType('DECIMAL(1,0)); DROP TABLE victim; --')).toBe('DOUBLE');
    expect(normalizeDuckDBType('DECIMAL')).toBe('DOUBLE');
  });
});
