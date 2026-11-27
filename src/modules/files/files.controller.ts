import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../../shared/auth/jwt-auth.guard';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FilesService } from './files.service';
import { DuckdbService } from '../duckdb/duckdb.service';

const ALLOWED_EXTENSIONS = new Set([
  '.csv', '.tsv', '.json', '.jsonl', '.parquet', '.geojson', '.topojson',
]);

function buildStorage(uploadsDir: string) {
  return diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(uploadsDir, { recursive: true });
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
    },
  });
}

function extensionFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, accept: boolean) => void,
) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new BadRequestException(`Tipo de archivo no soportado: ${ext}`), false);
  }
  cb(null, true);
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly duckdb: DuckdbService,
  ) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: buildStorage(UPLOADS_DIR),
      fileFilter: extensionFilter,
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadOne(@Req() req, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file received');

    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const baseName = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'uploaded_data';

    const tableName = await this.duckdb.resolveTableName(baseName, req.user.username);

    const { columns, rowCount } = await this.duckdb.loadFileFromDisk(
      file.path,
      tableName,
      ext,
      { createdAt: Date.now(), fileSize: file.size, fileType: ext, originalName: file.originalname, storedFile: file.filename, owners: [req.user.username] },
    ).catch((err) => {
      // A file that did not load into a table would never be listed or deleted again.
      fs.rmSync(file.path, { force: true });
      throw err;
    });

    return {
      originalName: file.originalname,
      filename: file.filename,
      tableName,
      columns,
      rowCount,
      size: file.size,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString(),
    };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('upload-many')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: buildStorage(UPLOADS_DIR),
      fileFilter: extensionFilter,
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadMany(@Req() req, @UploadedFiles() files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('Not received any files');

    return Promise.all(
      files.map(async (file) => {
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        const baseName = path.basename(file.originalname, path.extname(file.originalname))
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/^_+|_+$/g, '')
          .toLowerCase() || 'uploaded_data';

        const tableName = await this.duckdb.resolveTableName(baseName, req.user.username);

        const { columns, rowCount } = await this.duckdb.loadFileFromDisk(
          file.path,
          tableName,
          ext,
          { createdAt: Date.now(), fileSize: file.size, fileType: ext, originalName: file.originalname, storedFile: file.filename, owners: [req.user.username] },
        ).catch((err) => {
          // A file that did not load into a table would never be listed or deleted again.
          fs.rmSync(file.path, { force: true });
          throw err;
        });

        return {
          originalName: file.originalname,
          filename: file.filename,
          tableName,
          columns,
          rowCount,
          size: file.size,
          mimetype: file.mimetype,
          uploadedAt: new Date().toISOString(),
        };
      }),
    );
  }

  @Get()
  listFiles(@Req() req) {
    const mine = new Set(this.duckdb.storedFilesOf(req.user.username));
    return this.filesService.listFiles().filter((f) => mine.has(f.filename));
  }

  @Delete(':filename')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFile(@Req() req, @Param('filename') filename: string) {
    const tables = this.duckdb.tablesForStoredFile(filename, req.user.username);
    if (tables.length === 0) {
      throw new NotFoundException(`Archivo no encontrado: ${filename}`);
    }
    for (const t of tables) {
      await this.duckdb.dropTable(t, req.user.username);
    }
    if (this.duckdb.tablesForStoredFile(filename).length === 0) {
      this.filesService.deleteFile(filename);
    }
  }
}
