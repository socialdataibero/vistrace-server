import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../shared/auth/jwt-auth.guard';
import { PublishAnalysisDto } from './dto/publish-analysis.dto';
import { IberoService } from './ibero.service';

@UseGuards(JwtAuthGuard)
@Controller('ibero')
export class IberoController {
  constructor(private readonly ibero: IberoService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('analyses')
  publishAnalysis(@Req() req, @Body() dto: PublishAnalysisDto) {
    return this.ibero.publishAnalysis(dto, req.user.username);
  }
}
