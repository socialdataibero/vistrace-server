import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsISO8601, IsObject, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../../shared/auth/jwt-auth.guard';
import { CanvasesService } from './canvases.service';

class SaveCanvasDto {
  @IsObject()
  state!: Record<string, unknown>;

  // updatedAt of the version this save was made from; a newer stored version means another tab saved first.
  @IsOptional()
  @IsISO8601()
  baseSavedAt?: string;
}

const MAX_WORKSPACE_LENGTH = 200;

function parseWorkspace(workspace?: string): string | null {
  if (workspace === undefined || workspace === '') return null;
  if (typeof workspace !== 'string' || workspace.length > MAX_WORKSPACE_LENGTH) {
    throw new BadRequestException('INVALID_WORKSPACE');
  }
  return workspace;
}

@UseGuards(JwtAuthGuard)
@Controller('canvases')
export class CanvasesController {
  constructor(private readonly service: CanvasesService) {}

  @Get('mine')
  async getMine(@Req() req, @Query('workspace') workspace?: string) {
    return (await this.service.getMine(req.user.username, parseWorkspace(workspace))) ?? { state: null };
  }

  @Put('mine')
  saveMine(@Req() req, @Body() dto: SaveCanvasDto, @Query('workspace') workspace?: string) {
    return this.service.saveMine(req.user.username, parseWorkspace(workspace), dto.state, dto.baseSavedAt);
  }
}
