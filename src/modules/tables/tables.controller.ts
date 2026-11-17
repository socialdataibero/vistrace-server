import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { DuckdbService, ColumnInfo } from '../duckdb/duckdb.service';
import { JwtAuthGuard } from '../../shared/auth/jwt-auth.guard';

class ImportTableDto {
  @IsString()
  tableName: string;

  @IsArray()
  rows: Record<string, unknown>[];

  @IsArray()
  columns: ColumnInfo[];
}

class ImportFromUrlDto {
  @IsString()
  url: string;

  @IsString()
  tableName: string;

  @IsString()
  @IsOptional()
  format?: string;

  @IsString()
  @IsOptional()
  downloadToken?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('tables')
export class TablesController {
  constructor(private readonly duckdb: DuckdbService) { }

  @Get()
  listTables(@Req() req) {
    return this.duckdb.getTablesWithMeta(req.user.username);
  }

  @Get(':name/schema')
  async getSchema(@Req() req, @Param('name') name: string) {
    await this.duckdb.assertOwnsTable(name, req.user.username);
    return this.duckdb.getTableSchema(name);
  }

  @Get(':name/export')
  async exportTable(@Req() req, @Param('name') name: string) {
    await this.duckdb.assertOwnsTable(name, req.user.username);
    return this.duckdb.exportTableData(name);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  async importTable(@Req() req, @Body() dto: ImportTableDto) {
    await this.duckdb.assertCanReplace(dto.tableName, req.user.username);
    return this.duckdb.importTableData(dto.tableName, dto.rows, dto.columns, {
      owners: [req.user.username],
    });
  }

  @Post('import-from-url')
  @HttpCode(HttpStatus.OK)
  importFromUrl(@Req() req, @Body() dto: ImportFromUrlDto) {
    return this.duckdb.importFromUrl(dto.url, dto.tableName, dto.format ?? 'csv', dto.downloadToken, req.user.username);
  }

  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dropTable(@Req() req, @Param('name') name: string) {
    await this.duckdb.assertOwnsTable(name, req.user.username);
    await this.duckdb.dropTable(name, req.user.username);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  clearAllTables(@Req() req) {
    return this.duckdb.clearAllTables(req.user.username);
  }
}
