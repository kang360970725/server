import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MiniSubscribeMessageService } from '../notifications/mini-subscribe-message.service';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService, private readonly contentSecurity: MiniSubscribeMessageService) {}

  private clean(value: unknown, max: number) {
    return String(value || '').trim().slice(0, max);
  }

  private ticketInclude = {
    user: { select: { id: true, name: true, phone: true, avatar: true } },
    handler: { select: { id: true, name: true } },
    replies: {
      orderBy: { createdAt: 'asc' as const },
      include: { user: { select: { id: true, name: true, avatar: true } } },
    },
  };

  async create(userId: number, body: any) {
    const category = this.clean(body?.category, 32) || 'OTHER';
    const title = this.clean(body?.title, 120);
    const content = this.clean(body?.content, 3000);
    if (!title) throw new BadRequestException('请填写问题标题');
    if (content.length < 5) throw new BadRequestException('问题描述至少填写 5 个字');
    await this.contentSecurity.assertMiniTextSafe(userId, `${title}\n${content}`);
    const now = new Date();
    const ticketNo = `FB${now.toISOString().slice(0, 10).replace(/-/g, '')}${String(userId).padStart(6, '0')}${String(Date.now()).slice(-6)}`;
    return this.prisma.feedbackTicket.create({
      data: { ticketNo, userId, category, title, content, contact: this.clean(body?.contact, 120) || null },
      include: this.ticketInclude,
    });
  }

  async listMine(userId: number, query: any) {
    const page = Math.max(1, Number(query?.page || 1));
    const limit = Math.min(50, Math.max(1, Number(query?.limit || 20)));
    const where = { userId };
    const [list, total] = await this.prisma.$transaction([
      this.prisma.feedbackTicket.findMany({ where, include: this.ticketInclude, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.feedbackTicket.count({ where }),
    ]);
    return { list, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async detailMine(userId: number, id: number) {
    const ticket = await this.prisma.feedbackTicket.findFirst({ where: { id, userId }, include: this.ticketInclude });
    if (!ticket) throw new NotFoundException('反馈工单不存在');
    return ticket;
  }

  async replyMine(userId: number, id: number, body: any) {
    const content = this.clean(body?.content, 2000);
    if (!content) throw new BadRequestException('请输入补充内容');
    const ticket = await this.detailMine(userId, id);
    if (ticket.status === 'CLOSED') throw new BadRequestException('该反馈已关闭');
    const lastReply = ticket.replies[ticket.replies.length - 1];
    if (!lastReply || lastReply.authorType !== 'STAFF') {
      throw new BadRequestException('客服回复后可继续补充，请耐心等待处理');
    }
    await this.contentSecurity.assertMiniTextSafe(userId, content);
    await this.prisma.$transaction([
      this.prisma.feedbackReply.create({ data: { ticketId: id, userId, authorType: 'USER', content } }),
      this.prisma.feedbackTicket.update({ where: { id }, data: { status: 'PENDING', lastReplyAt: new Date() } }),
    ]);
    return this.detailMine(userId, id);
  }

  async adminList(query: any) {
    const page = Math.max(1, Number(query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit || 20)));
    const keyword = this.clean(query?.keyword, 120);
    const status = this.clean(query?.status, 24);
    const where: Prisma.FeedbackTicketWhereInput = {
      ...(status ? { status } : {}),
      ...(keyword ? { OR: [
        { ticketNo: { contains: keyword } }, { title: { contains: keyword } }, { content: { contains: keyword } },
        { user: { is: { OR: [{ name: { contains: keyword } }, { phone: { contains: keyword } }] } } },
      ] } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.feedbackTicket.findMany({ where, include: this.ticketInclude, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.feedbackTicket.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async adminDetail(id: number) {
    const ticket = await this.prisma.feedbackTicket.findUnique({ where: { id }, include: this.ticketInclude });
    if (!ticket) throw new NotFoundException('反馈工单不存在');
    return ticket;
  }

  async adminReply(operatorId: number, id: number, body: any) {
    const content = this.clean(body?.content, 2000);
    if (!content) throw new BadRequestException('请输入回复内容');
    const ticket = await this.adminDetail(id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.feedbackReply.create({ data: { ticketId: id, userId: operatorId, authorType: 'STAFF', content } }),
      this.prisma.feedbackTicket.update({ where: { id }, data: { status: 'PROCESSING', handledBy: operatorId, lastReplyAt: now, closedAt: null } }),
      this.prisma.userNotification.create({ data: {
        userId: ticket.userId, type: NotificationType.FEEDBACK_REPLY, title: '问题反馈有新回复',
        content: `${ticket.title}：${content.slice(0, 80)}`,
        payload: { feedbackTicketId: id, page: `/pages/feedback-list/index?id=${id}` },
      } }),
    ]);
    return this.adminDetail(id);
  }

  async adminStatus(operatorId: number, id: number, body: any) {
    const status = this.clean(body?.status, 24).toUpperCase();
    if (!['PENDING', 'PROCESSING', 'REPLIED', 'CLOSED'].includes(status)) throw new BadRequestException('状态不正确');
    await this.adminDetail(id);
    return this.prisma.feedbackTicket.update({
      where: { id },
      data: { status, handledBy: operatorId, closedAt: status === 'CLOSED' ? new Date() : null },
      include: this.ticketInclude,
    });
  }
}
