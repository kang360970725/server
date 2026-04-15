import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PenaltiesService } from './penalties.service';
import { CreatePenaltyRuleDto } from './dto/create-penalty-rule.dto';
import { UpdatePenaltyRuleDto } from './dto/update-penalty-rule.dto';
import { CreatePenaltyTicketDto } from './dto/create-penalty-ticket.dto';
import { SubmitPenaltyAppealDto } from './dto/submit-penalty-appeal.dto';
import { ReviewPenaltyAppealDto } from './dto/review-penalty-appeal.dto';
import { ConfirmPenaltyTicketDto } from './dto/confirm-penalty-ticket.dto';
import { ListPenaltyFundFlowsDto } from './dto/list-penalty-fund-flows.dto';
import { ListPenaltyRankingDto } from './dto/list-penalty-ranking.dto';

const PENALTIES_PAGE = 'penalties:page';
const LEGACY_PAGE = 'system:role:page';

@Controller('penalties')
@UseGuards(JwtAuthGuard)
export class PenaltiesController {
  constructor(private readonly penaltiesService: PenaltiesService) {}

  // ===== 管理端：处罚条例 =====

  @Post('rules/list')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listRules(@Body() body: any) {
    return this.penaltiesService.listRules(body || {});
  }

  @Post('rules/options')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listRuleOptions() {
    return this.penaltiesService.listEnabledRulesForSelect();
  }

  @Post('dict')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  dict() {
    return this.penaltiesService.getDict();
  }

  @Post('rules/create')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  createRule(@Body() dto: CreatePenaltyRuleDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.createRule(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('rules/update')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  updateRule(@Body() dto: UpdatePenaltyRuleDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.updateRule(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  // ===== 管理端：罚单 =====

  @Post('tickets/context')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  getCreateTicketContext(@Body() body: any) {
    return this.penaltiesService.getCreateTicketContext(Number(body?.userId), body?.ruleIds || []);
  }

  @Post('tickets/create')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  createTicket(@Body() dto: CreatePenaltyTicketDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.createTicket(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('tickets/list')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listTickets(@Body() body: any) {
    return this.penaltiesService.listTickets(body || {});
  }

  @Post('appeals/list')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listAppeals(@Body() body: any) {
    return this.penaltiesService.listAppeals(body || {});
  }

  @Post('tickets/detail')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  ticketDetail(@Body() body: any) {
    return this.penaltiesService.getTicketDetail(Number(body?.ticketId));
  }

  @Post('tickets/remind')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  remindTicket(@Body() body: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.remindTicket(
      Number(body?.ticketId),
      Number.isFinite(operatorId) ? operatorId : undefined,
    );
  }

  @Post('tickets/review-appeal')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  reviewAppeal(@Body() dto: ReviewPenaltyAppealDto, @Req() req: any) {
    const reviewerId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.reviewAppeal(dto, Number.isFinite(reviewerId) ? reviewerId : undefined);
  }

  // ===== 管理端：罚款资金池/统计 =====

  @Post('fund/stats')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  getFundStats() {
    return this.penaltiesService.getFundStats();
  }

  @Post('stats/pending')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  getPendingStats() {
    return this.penaltiesService.getAdminPendingStats();
  }

  @Post('stats/overview')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  getOverview() {
    return this.penaltiesService.getAdminOverview();
  }

  @Post('fund/flows')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listFundFlows(@Body() dto: ListPenaltyFundFlowsDto) {
    return this.penaltiesService.listFundFlows(dto || {});
  }

  @Post('ranking/list')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  listRanking(@Body() dto: ListPenaltyRankingDto) {
    return this.penaltiesService.listPenaltyRanking(dto || {});
  }

  @Post('stats/rule-categories')
  @UseGuards(PermissionsGuard)
  @Permissions(PENALTIES_PAGE, LEGACY_PAGE)
  ruleCategoryStats(@Body() body: any) {
    return this.penaltiesService.getRuleCategoryStats(Number(body?.userId));
  }

  // ===== 陪玩端：我的罚单 =====

  @Post('my/tickets/list')
  listMyTickets(@Body() body: any, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.listMyTickets(userId, body || {});
  }

  @Post('my/tickets/detail')
  myTicketDetail(@Body() body: any, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.getTicketDetail(Number(body?.ticketId), userId);
  }

  @Post('my/tickets/pending-stats')
  myPendingStats(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.getMyPendingStats(userId);
  }

  @Post('my/tickets/confirm')
  confirmMyTicket(@Body() dto: ConfirmPenaltyTicketDto, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.confirmMyTicket(userId, dto);
  }

  @Post('my/tickets/appeal')
  submitMyAppeal(@Body() dto: SubmitPenaltyAppealDto, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.penaltiesService.submitMyAppeal(userId, dto);
  }
}
