import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// A whole result is held in server memory and sent as JSON; past this a query must aggregate or page.
export const MAX_QUERY_ROWS = 50_000;

export class ExecuteQueryDto {
  @IsString()
  sql: string;
}

export class ExecuteQueryLimitedDto {
  @IsString()
  sql: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_QUERY_ROWS)
  limit?: number;
}
