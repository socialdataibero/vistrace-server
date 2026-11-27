import { ConflictException, HttpException, HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CanvasState } from './canvas-state.schema';
import { PUBLIC_VISITOR_SWEEP_MS, PUBLIC_VISITOR_TTL_MS } from '../../shared/auth/public-visitor';

@Injectable()
export class CanvasesService implements OnModuleInit {
  private readonly logger = new Logger(CanvasesService.name);

  constructor(
    @InjectModel(CanvasState.name) private model: Model<CanvasState>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.model.syncIndexes();
    } catch (error) {
      this.logger.warn(`cannot sync canvas indexes: ${(error as Error).message}`);
    }
    setInterval(() => void this.deleteExpiredVisitorCanvases(), PUBLIC_VISITOR_SWEEP_MS).unref();
  }

  async deleteExpiredVisitorCanvases(now = Date.now()): Promise<number> {
    const result = await this.model.deleteMany({
      username: /@public\.ibero-data$/i,
      updatedAt: { $lt: new Date(now - PUBLIC_VISITOR_TTL_MS) },
    }).exec();
    return result.deletedCount ?? 0;
  }

  async getMine(username: string, workspace: string | null): Promise<{ state: Record<string, unknown>; updatedAt?: Date } | null> {
    const doc = await this.model.findOne(this.key(username, workspace)).lean().exec();
    if (!doc) return null;
    return {
      state: doc.state,
      updatedAt: (doc as { updatedAt?: Date }).updatedAt,
    };
  }

  async saveMine(username: string, workspace: string | null, state: Record<string, unknown>, baseSavedAt?: string) {
    const key = this.key(username, workspace);
    try {
      // With a base version only that exact version is replaced (no upsert); without one, the legacy last-write-wins upsert.
      const doc = baseSavedAt
        ? await this.model.findOneAndUpdate(
          { ...key, updatedAt: new Date(baseSavedAt) },
          { $set: { state } },
          { returnDocument: 'after' },
        ).exec()
        : await this.model.findOneAndUpdate(key, { $set: { state } }, { returnDocument: 'after', upsert: true }).exec();
      if (!doc) throw new ConflictException('CANVAS_CHANGED');
      return { savedAt: (doc as unknown as { updatedAt?: Date }).updatedAt ?? new Date() };
    } catch (error: any) {
      if (error instanceof ConflictException) throw error;
      this.logger.error(error);
      throw new HttpException(
        { message: ['ERROR_SAVING_CANVAS'] },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private key(username: string, workspace: string | null) {
    return { username: username.toLowerCase(), workspace };
  }
}
