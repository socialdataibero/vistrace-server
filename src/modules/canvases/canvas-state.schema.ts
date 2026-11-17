import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class CanvasState {
  @Prop({ required: true, index: true })
  username!: string;

  @Prop({ type: String, default: null })
  workspace!: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  state!: Record<string, unknown>;
}

export const CanvasStateSchema = SchemaFactory.createForClass(CanvasState);
CanvasStateSchema.index({ username: 1, workspace: 1 }, { unique: true });
