import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { JwtAuthGuard } from '../../shared/auth/jwt-auth.guard';
import { CanvasesService } from './canvases.service';

class SaveCanvasDto {
  @IsObject()
  state!: Record<string, unknown>;
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
    return this.service.saveMine(req.user.username, parseWorkspace(workspace), dto.state);
  }
}
