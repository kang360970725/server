import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type Scope = 'INTERNAL_STAFF' | 'MEMBER_LOGIN' | 'UNRESTRICTED';
type Status = 'DRAFT' | 'PUBLISHED' | 'CLOSED';
type QuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT';

const INTERNAL_USER_TYPES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'STAFF',
  'CUSTOMER_SERVICE',
  'OPERATION',
  'FINANCE',
]);

@Injectable()
export class QuestionnaireService {
  constructor(private readonly prisma: PrismaService) {}

  extractRequestMeta(req: any) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
    const ip = String(forwarded.split(',')[0] || req?.ip || req?.socket?.remoteAddress || '').trim();
    const userAgent = String(req?.headers?.['user-agent'] || '').trim().slice(0, 512);
    return {
      ip,
      userAgent,
    };
  }

  private normalizeScope(input: any): Scope {
    const value = String(input || 'UNRESTRICTED').trim().toUpperCase();
    if (value === 'INTERNAL_STAFF' || value === 'MEMBER_LOGIN' || value === 'UNRESTRICTED') return value;
    throw new BadRequestException('问卷适用范围不合法');
  }

  private normalizeStatus(input: any): Status {
    const value = String(input || 'DRAFT').trim().toUpperCase();
    if (value === 'DRAFT' || value === 'PUBLISHED' || value === 'CLOSED') return value;
    throw new BadRequestException('问卷状态不合法');
  }

  private normalizeQuestionType(input: any): QuestionType {
    const value = String(input || '').trim().toUpperCase();
    if (value === 'SINGLE_CHOICE' || value === 'MULTIPLE_CHOICE' || value === 'TEXT') return value;
    throw new BadRequestException('题目类型不合法');
  }

  private normalizeDate(input: any) {
    if (!input) return null;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('时间格式不合法');
    return d;
  }

  private ensureQuestions(rawQuestions: any[]) {
    const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
    if (!questions.length) throw new BadRequestException('至少需要配置一个题目');
    return questions.map((raw, idx) => {
      const type = this.normalizeQuestionType(raw?.type);
      const title = String(raw?.title || '').trim();
      const description = String(raw?.description || '').trim() || null;
      const required = Boolean(raw?.required);
      const sortOrder = Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : idx + 1;
      if (!title) throw new BadRequestException(`第 ${idx + 1} 个题目标题不能为空`);

      const options = Array.isArray(raw?.options) ? raw.options : [];
      if (type !== 'TEXT' && !options.length) {
        throw new BadRequestException(`第 ${idx + 1} 个题目至少需要一个选项`);
      }
      if (type === 'TEXT' && options.length) {
        throw new BadRequestException(`问答题不应配置选项：第 ${idx + 1} 题`);
      }
      if (type !== 'TEXT' && options.filter((opt: any) => Boolean(opt?.isOther)).length > 1) {
        throw new BadRequestException(`第 ${idx + 1} 题最多只能配置一个“其他”选项`);
      }
      return {
        title,
        description,
        type,
        required,
        sortOrder,
        options: options.map((opt: any, optIdx: number) => {
          const label = String(opt?.label || '').trim();
          if (!label) throw new BadRequestException(`第 ${idx + 1} 题第 ${optIdx + 1} 个选项不能为空`);
          return {
            label,
            isOther: Boolean(opt?.isOther),
            sortOrder: Number.isFinite(Number(opt?.sortOrder)) ? Number(opt.sortOrder) : optIdx + 1,
          };
        }),
      };
    });
  }

  private normalizeQuestionConfigForCompare(questions: any[]) {
    return (Array.isArray(questions) ? questions : [])
      .map((q: any) => ({
        title: String(q?.title || '').trim(),
        description: String(q?.description || '').trim() || '',
        type: String(q?.type || '').trim(),
        required: Boolean(q?.required),
        sortOrder: Number(q?.sortOrder || 0),
        options: (Array.isArray(q?.options) ? q.options : [])
          .map((opt: any) => ({
            label: String(opt?.label || '').trim(),
            isOther: Boolean(opt?.isOther),
            sortOrder: Number(opt?.sortOrder || 0),
          }))
          .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || a.label.localeCompare(b.label)),
      }))
      .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || a.title.localeCompare(b.title));
  }

  private isQuestionnaireOpen(item: any) {
    const now = Date.now();
    if (String(item?.status || '') !== 'PUBLISHED') return false;
    if (item?.startAt && new Date(item.startAt).getTime() > now) return false;
    if (item?.endAt && new Date(item.endAt).getTime() < now) return false;
    return true;
  }

  private async getUserProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: Number(userId) },
      select: {
        id: true,
        name: true,
        phone: true,
        userType: true,
        staffEmploymentStatus: true,
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  private assertUserCanAccessScope(scope: Scope, user: any) {
    const userType = String(user?.userType || '').trim().toUpperCase();
    const staffEmploymentStatus = String(user?.staffEmploymentStatus || '').trim().toUpperCase();
    if (scope === 'UNRESTRICTED') return;
    if (scope === 'MEMBER_LOGIN') {
      if (userType !== 'REGISTERED_USER') throw new ForbiddenException('当前问卷仅会员可参与');
      return;
    }
    if (!INTERNAL_USER_TYPES.has(userType)) {
      throw new ForbiddenException('当前问卷仅内部员工可参与');
    }
    if (userType === 'STAFF' && (staffEmploymentStatus === 'EXITED' || staffEmploymentStatus === 'BLACKLISTED')) {
      throw new ForbiddenException('当前问卷仅在职内部员工可参与');
    }
  }

  private serializeQuestionnaireBase(item: any) {
    return {
      id: item.id,
      title: item.title,
      description: item.description || '',
      scope: item.scope,
      status: item.status,
      publishedAt: item.publishedAt,
      startAt: item.startAt,
      endAt: item.endAt,
      allowEditSubmit: Boolean(item.allowEditSubmit),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private serializeQuestionnaireForParticipant(item: any, submitted = false, mySubmission: any = null) {
    return {
      ...this.serializeQuestionnaireBase(item),
      submitted,
      mySubmission: mySubmission
        ? {
            id: mySubmission.id,
            createdAt: mySubmission.createdAt,
            answers: (Array.isArray(mySubmission?.answers) ? mySubmission.answers : []).map((ans: any) => ({
              id: ans.id,
              questionId: ans.questionId,
              optionId: ans.optionId || null,
              textValue: ans.textValue || '',
            })),
          }
        : null,
      questions: (Array.isArray(item?.questions) ? item.questions : [])
        .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
        .map((q: any) => ({
          id: q.id,
          title: q.title,
          description: q.description || '',
          type: q.type,
          required: Boolean(q.required),
          sortOrder: q.sortOrder,
          options: (Array.isArray(q?.options) ? q.options : [])
            .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
            .map((opt: any) => ({
              id: opt.id,
              label: opt.label,
              isOther: Boolean(opt.isOther),
              sortOrder: opt.sortOrder,
            })),
        })),
    };
  }

  private buildStatistics(questionnaire: any) {
    const questions = Array.isArray(questionnaire?.questions) ? questionnaire.questions : [];
    const submissions = Array.isArray(questionnaire?.submissions) ? questionnaire.submissions : [];
    return questions
      .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
      .map((q: any) => {
        const answers = submissions.flatMap((submission: any) =>
          (Array.isArray(submission?.answers) ? submission.answers : []).filter((ans: any) => Number(ans?.questionId) === Number(q.id)),
        );
        const options = (Array.isArray(q?.options) ? q.options : [])
          .sort((a: any, b: any) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
          .map((opt: any) => ({
            id: opt.id,
            label: opt.label,
            voteCount: answers.filter((ans: any) => Number(ans?.optionId) === Number(opt.id)).length,
            isOther: Boolean(opt.isOther),
            textAnswers: answers
              .filter((ans: any) => Number(ans?.optionId) === Number(opt.id) && String(ans?.textValue || '').trim())
              .map((ans: any) => ({
                id: ans.id,
                textValue: String(ans?.textValue || '').trim(),
                submitterName: ans?.submission?.submitterName || ans?.submission?.user?.name || '',
                submitterPhone: ans?.submission?.submitterPhone || ans?.submission?.user?.phone || '',
                createdAt: ans?.createdAt,
              })),
          }));
        const textAnswers = q.type === 'TEXT'
          ? answers
              .map((ans: any) => ({
                id: ans.id,
                textValue: String(ans?.textValue || '').trim(),
                submitterName: ans?.submission?.submitterName || ans?.submission?.user?.name || '',
                submitterPhone: ans?.submission?.submitterPhone || ans?.submission?.user?.phone || '',
                createdAt: ans?.createdAt,
              }))
              .filter((row: any) => row.textValue)
          : [];
        return {
          questionId: q.id,
          title: q.title,
          type: q.type,
          required: Boolean(q.required),
          optionStats: options,
          textAnswerCount: textAnswers.length,
          textAnswers,
        };
      });
  }

  async adminList(body: any) {
    const page = Math.max(1, Number(body?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 20)));
    const keyword = String(body?.keyword || '').trim();
    const scope = String(body?.scope || '').trim().toUpperCase();
    const status = String(body?.status || '').trim().toUpperCase();

    const where: any = {};
    if (keyword) {
      where.OR = [
        { title: { contains: keyword } },
        { description: { contains: keyword } },
      ];
    }
    if (scope) where.scope = scope;
    if (status) where.status = status;

    const [rows, total] = await Promise.all([
      (this.prisma as any).questionnaire.findMany({
        where,
        include: {
          creator: { select: { id: true, name: true, phone: true } },
          _count: { select: { submissions: true, questions: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      (this.prisma as any).questionnaire.count({ where }),
    ]);

    return {
      list: (Array.isArray(rows) ? rows : []).map((row: any) => ({
        ...this.serializeQuestionnaireBase(row),
        creator: row?.creator || null,
        questionCount: Number(row?._count?.questions || 0),
        submissionCount: Number(row?._count?.submissions || 0),
        isOpen: this.isQuestionnaireOpen(row),
      })),
      total,
      page,
      limit,
    };
  }

  async adminCreate(body: any, operatorId?: number) {
    const title = String(body?.title || '').trim();
    if (!title) throw new BadRequestException('问卷标题不能为空');
    const description = String(body?.description || '').trim() || null;
    const scope = this.normalizeScope(body?.scope);
    const status = this.normalizeStatus(body?.status);
    const startAt = this.normalizeDate(body?.startAt);
    const endAt = this.normalizeDate(body?.endAt);
    if (startAt && endAt && startAt.getTime() > endAt.getTime()) {
      throw new BadRequestException('开始时间不能晚于结束时间');
    }
    const questions = this.ensureQuestions(body?.questions);

    return this.prisma.$transaction(async (tx) => {
      const created = await (tx as any).questionnaire.create({
        data: {
          title,
          description,
          scope,
          status,
          publishedAt: status === 'PUBLISHED' ? new Date() : null,
          startAt,
          endAt,
          allowEditSubmit: Boolean(body?.allowEditSubmit),
          createdBy: operatorId || null,
        },
      });

      for (const question of questions) {
        const createdQuestion = await (tx as any).questionnaireQuestion.create({
          data: {
            questionnaireId: created.id,
            title: question.title,
            description: question.description,
            type: question.type,
            required: question.required,
            sortOrder: question.sortOrder,
          },
        });
        if (question.options.length) {
          await (tx as any).questionnaireOption.createMany({
            data: question.options.map((opt: any) => ({
              questionId: createdQuestion.id,
              label: opt.label,
              isOther: Boolean(opt.isOther),
              sortOrder: opt.sortOrder,
            })),
          });
        }
      }
      return this.adminDetail(created.id, tx as any);
    });
  }

  async adminUpdate(body: any, operatorId?: number) {
    const id = Number(body?.id || 0);
    if (!id) throw new BadRequestException('问卷ID不能为空');
    const current = await (this.prisma as any).questionnaire.findUnique({
      where: { id },
      include: {
        questions: {
          include: { options: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        _count: { select: { submissions: true } },
      },
    });
    if (!current) throw new NotFoundException('问卷不存在');

    const title = String(body?.title || '').trim();
    if (!title) throw new BadRequestException('问卷标题不能为空');
    const description = String(body?.description || '').trim() || null;
    const scope = this.normalizeScope(body?.scope);
    const status = this.normalizeStatus(body?.status);
    const startAt = this.normalizeDate(body?.startAt);
    const endAt = this.normalizeDate(body?.endAt);
    if (startAt && endAt && startAt.getTime() > endAt.getTime()) {
      throw new BadRequestException('开始时间不能晚于结束时间');
    }
    const questions = this.ensureQuestions(body?.questions);
    const nextQuestionConfig = this.normalizeQuestionConfigForCompare(questions);
    const currentQuestionConfig = this.normalizeQuestionConfigForCompare(current?.questions || []);
    const questionsChanged = JSON.stringify(nextQuestionConfig) !== JSON.stringify(currentQuestionConfig);
    if (Number(current?._count?.submissions || 0) > 0 && questionsChanged) {
      throw new BadRequestException('问卷已有参与记录，不能再修改题目结构');
    }

    return this.prisma.$transaction(async (tx) => {
      await (tx as any).questionnaire.update({
        where: { id },
        data: {
          title,
          description,
          scope,
          status,
          publishedAt: status === 'PUBLISHED' && !current?.publishedAt ? new Date() : current?.publishedAt,
          startAt,
          endAt,
          allowEditSubmit: Boolean(body?.allowEditSubmit),
          createdBy: operatorId || current?.createdBy || null,
        },
      });

      if (questionsChanged) {
        await (tx as any).questionnaireOption.deleteMany({
          where: {
            question: {
              questionnaireId: id,
            },
          },
        });
        await (tx as any).questionnaireQuestion.deleteMany({ where: { questionnaireId: id } });

        for (const question of questions) {
          const createdQuestion = await (tx as any).questionnaireQuestion.create({
            data: {
              questionnaireId: id,
              title: question.title,
              description: question.description,
              type: question.type,
              required: question.required,
              sortOrder: question.sortOrder,
            },
          });
          if (question.options.length) {
            await (tx as any).questionnaireOption.createMany({
              data: question.options.map((opt: any) => ({
                questionId: createdQuestion.id,
                label: opt.label,
                isOther: Boolean(opt.isOther),
                sortOrder: opt.sortOrder,
              })),
            });
          }
        }
      }

      return this.adminDetail(id, tx as any);
    });
  }

  async adminDetail(id: number, prismaLike?: any) {
    const db = prismaLike || this.prisma;
    const row = await (db as any).questionnaire.findUnique({
      where: { id: Number(id) },
      include: {
        creator: { select: { id: true, name: true, phone: true } },
        questions: {
          include: {
            options: true,
          },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        submissions: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                phone: true,
                userType: true,
                staffEmploymentStatus: true,
              },
            },
            answers: {
              include: {
                option: true,
                question: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }],
        },
      },
    });
    if (!row) throw new NotFoundException('问卷不存在');

    return {
      ...this.serializeQuestionnaireBase(row),
      creator: row?.creator || null,
      questions: (Array.isArray(row?.questions) ? row.questions : []).map((q: any) => ({
        id: q.id,
        title: q.title,
        description: q.description || '',
        type: q.type,
        required: Boolean(q.required),
        sortOrder: q.sortOrder,
        options: (Array.isArray(q?.options) ? q.options : []).map((opt: any) => ({
          id: opt.id,
          label: opt.label,
          isOther: Boolean(opt.isOther),
          sortOrder: opt.sortOrder,
        })),
      })),
      submissionCount: Number(row?.submissions?.length || 0),
      statistics: this.buildStatistics(row),
      submissions: (Array.isArray(row?.submissions) ? row.submissions : []).map((submission: any) => ({
        id: submission.id,
        userId: submission?.user?.id || submission?.userId || null,
        submitterName: submission?.user?.name || submission?.submitterName || '',
        submitterPhone: submission?.user?.phone || submission?.submitterPhone || '',
        submitterUserType: submission?.user?.userType || submission?.submitterUserType || '',
        submitterStaffStatus: submission?.user?.staffEmploymentStatus || submission?.submitterStaffStatus || '',
        visitorToken: submission?.visitorToken || '',
        clientIp: submission?.clientIp || '',
        createdAt: submission?.createdAt,
        answers: (Array.isArray(submission?.answers) ? submission.answers : []).map((ans: any) => ({
          id: ans.id,
          questionId: ans.questionId,
          questionTitle: ans?.question?.title || '',
          optionId: ans.optionId || null,
          optionLabel: ans?.option?.label || '',
          textValue: ans?.textValue || '',
        })),
      })),
    };
  }

  async listAvailableForUser(userId: number) {
    const user = await this.getUserProfile(userId);
    const rows = await (this.prisma as any).questionnaire.findMany({
      where: { status: 'PUBLISHED' },
      include: {
        _count: { select: { submissions: true } },
        submissions: {
          where: { userId: Number(userId) },
          select: { id: true },
        },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((row: any) => this.isQuestionnaireOpen(row))
      .filter((row: any) => {
        try {
          this.assertUserCanAccessScope(String(row.scope) as Scope, user);
          return true;
        } catch {
          return false;
        }
      })
      .map((row: any) => ({
        ...this.serializeQuestionnaireBase(row),
        submitted: Boolean(row?.submissions?.length),
        submissionCount: Number(row?._count?.submissions || 0),
      }));
  }

  async listPublicAvailable() {
    const rows = await (this.prisma as any).questionnaire.findMany({
      where: {
        status: 'PUBLISHED',
        scope: 'UNRESTRICTED',
      },
      include: {
        _count: { select: { submissions: true } },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((row: any) => this.isQuestionnaireOpen(row))
      .map((row: any) => ({
        ...this.serializeQuestionnaireBase(row),
        submissionCount: Number(row?._count?.submissions || 0),
      }));
  }

  async userDetail(id: number, userId: number) {
    const user = await this.getUserProfile(userId);
    const row = await (this.prisma as any).questionnaire.findUnique({
      where: { id: Number(id) },
      include: {
        questions: { include: { options: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        submissions: {
          where: { userId: Number(userId) },
          include: {
            answers: {
              orderBy: [{ id: 'asc' }],
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    });
    if (!row || !this.isQuestionnaireOpen(row)) throw new NotFoundException('问卷不存在或未开放');
    this.assertUserCanAccessScope(String(row.scope) as Scope, user);
    const mySubmission = Array.isArray(row?.submissions) && row.submissions.length ? row.submissions[0] : null;
    return this.serializeQuestionnaireForParticipant(row, Boolean(mySubmission), mySubmission);
  }

  async publicDetail(id: number) {
    const row = await (this.prisma as any).questionnaire.findUnique({
      where: { id: Number(id) },
      include: {
        questions: { include: { options: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row || !this.isQuestionnaireOpen(row) || String(row?.scope) !== 'UNRESTRICTED') {
      throw new NotFoundException('问卷不存在或未开放');
    }
    return this.serializeQuestionnaireForParticipant(row, false);
  }

  private async buildSubmissionPayload(questionnaireId: number, body: any, user: any | null, requestMeta: { ip?: string; userAgent?: string }) {
    const questionnaire = await (this.prisma as any).questionnaire.findUnique({
      where: { id: Number(questionnaireId) },
      include: {
        questions: {
          include: { options: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!questionnaire || !this.isQuestionnaireOpen(questionnaire)) {
      throw new NotFoundException('问卷不存在或未开放');
    }

    if (user) {
      this.assertUserCanAccessScope(String(questionnaire.scope) as Scope, user);
    } else if (String(questionnaire.scope) !== 'UNRESTRICTED') {
      throw new ForbiddenException('当前问卷需要登录后参与');
    }

    const answersInput = Array.isArray(body?.answers) ? body.answers : [];
    if (!answersInput.length) throw new BadRequestException('请至少提交一个回答');

    const questionMap = new Map<number, any>();
    for (const question of questionnaire.questions || []) {
      questionMap.set(Number(question.id), question);
    }

    const normalizedAnswers: Array<{
      questionId: number;
      selectedOptions: Array<{ optionId: number; textValue: string | null }>;
      textValue: string | null;
    }> = [];
    for (const item of answersInput) {
      const questionId = Number(item?.questionId || 0);
      const question = questionMap.get(questionId);
      if (!question) throw new BadRequestException('存在无效题目');

      if (String(question.type) === 'TEXT') {
        const textValue = String(item?.textValue || '').trim();
        if (question.required && !textValue) throw new BadRequestException(`题目“${question.title}”不能为空`);
        normalizedAnswers.push({ questionId, selectedOptions: [], textValue: textValue || null });
        continue;
      }

      const optionIds = [...new Set(
        (Array.isArray(item?.optionIds) ? item.optionIds : [item?.optionId])
          .map((v: any) => Number(v))
          .filter((v: number) => Number.isFinite(v) && v > 0),
      )] as number[];

      if (question.required && !optionIds.length) throw new BadRequestException(`题目“${question.title}”至少选择一个选项`);
      if (String(question.type) === 'SINGLE_CHOICE' && optionIds.length > 1) {
        throw new BadRequestException(`题目“${question.title}”只能选择一个选项`);
      }
      const optionMap = new Map<number, any>((Array.isArray(question?.options) ? question.options : []).map((opt: any) => [Number(opt.id), opt]));
      const optionTexts = item?.optionTexts && typeof item.optionTexts === 'object' ? item.optionTexts : {};
      const selectedOptions = optionIds.map((optionId: number) => {
        const option = optionMap.get(Number(optionId));
        if (!option) throw new BadRequestException(`题目“${question.title}”存在无效选项`);
        let textValue: string | null = null;
        if (Boolean(option?.isOther)) {
          const raw = String(optionTexts?.[String(optionId)] ?? item?.otherText ?? '').trim();
          if (!raw) throw new BadRequestException(`题目“${question.title}”的“其他”选项需要填写内容`);
          textValue = raw;
        }
        return {
          optionId: Number(optionId),
          textValue,
        };
      });
      normalizedAnswers.push({ questionId, selectedOptions, textValue: null });
    }

    for (const question of questionnaire.questions || []) {
      if (!question.required) continue;
      const exists = normalizedAnswers.find((item) => Number(item.questionId) === Number(question.id));
      if (!exists) throw new BadRequestException(`题目“${question.title}”不能为空`);
      if (String(question.type) === 'TEXT' && !String(exists.textValue || '').trim()) {
        throw new BadRequestException(`题目“${question.title}”不能为空`);
      }
      if (String(question.type) !== 'TEXT' && !(Array.isArray(exists.selectedOptions) && exists.selectedOptions.length)) {
        throw new BadRequestException(`题目“${question.title}”至少选择一个选项`);
      }
    }

    return {
      questionnaire,
      normalizedAnswers,
      visitorToken: String(body?.visitorToken || '').trim().slice(0, 128) || null,
      requestMeta,
      user,
    };
  }

  async submitForUser(questionnaireId: number, userId: number, body: any, requestMeta: { ip?: string; userAgent?: string }) {
    const user = await this.getUserProfile(userId);
    const payload = await this.buildSubmissionPayload(questionnaireId, body, user, requestMeta);
    return this.saveSubmission(payload);
  }

  async submitForGuest(questionnaireId: number, body: any, requestMeta: { ip?: string; userAgent?: string }) {
    const payload = await this.buildSubmissionPayload(questionnaireId, body, null, requestMeta);
    return this.saveSubmission(payload);
  }

  private async saveSubmission(payload: any) {
    const { questionnaire, normalizedAnswers, visitorToken, requestMeta, user } = payload;
    const allowEditSubmit = Boolean(questionnaire?.allowEditSubmit);

    return this.prisma.$transaction(async (tx) => {
      let existingSubmission: any = null;

      if (user?.id) {
        existingSubmission = await (tx as any).questionnaireSubmission.findFirst({
          where: {
            questionnaireId: Number(questionnaire.id),
            userId: Number(user.id),
          },
        });
      } else if (visitorToken) {
        existingSubmission = await (tx as any).questionnaireSubmission.findFirst({
          where: {
            questionnaireId: Number(questionnaire.id),
            visitorToken,
          },
          orderBy: [{ createdAt: 'desc' }],
        });
      }

      if (existingSubmission && !allowEditSubmit) {
        throw new BadRequestException('当前问卷已提交，不能重复参与');
      }

      let submission = existingSubmission;
      if (submission) {
        await (tx as any).questionnaireAnswer.deleteMany({
          where: { submissionId: Number(submission.id) },
        });
        submission = await (tx as any).questionnaireSubmission.update({
          where: { id: Number(submission.id) },
          data: {
            submitterName: user?.name || null,
            submitterPhone: user?.phone || null,
            submitterUserType: user?.userType || null,
            submitterStaffStatus: user?.staffEmploymentStatus || null,
            visitorToken,
            clientIp: requestMeta?.ip || null,
            userAgent: requestMeta?.userAgent || null,
          },
        });
      } else {
        submission = await (tx as any).questionnaireSubmission.create({
          data: {
            questionnaireId: Number(questionnaire.id),
            userId: user?.id || null,
            submitterName: user?.name || null,
            submitterPhone: user?.phone || null,
            submitterUserType: user?.userType || null,
            submitterStaffStatus: user?.staffEmploymentStatus || null,
            visitorToken,
            clientIp: requestMeta?.ip || null,
            userAgent: requestMeta?.userAgent || null,
          },
        });
      }

      for (const answer of normalizedAnswers) {
        if (String((questionnaire.questions || []).find((item: any) => Number(item.id) === Number(answer.questionId))?.type) === 'TEXT') {
          if (!String(answer.textValue || '').trim()) continue;
          await (tx as any).questionnaireAnswer.create({
            data: {
              submissionId: Number(submission.id),
              questionId: Number(answer.questionId),
              textValue: String(answer.textValue || '').trim(),
            },
          });
        } else {
          for (const selected of answer.selectedOptions || []) {
            await (tx as any).questionnaireAnswer.create({
              data: {
                submissionId: Number(submission.id),
                questionId: Number(answer.questionId),
                optionId: Number(selected.optionId),
                textValue: String(selected.textValue || '').trim() || null,
              },
            });
          }
        }
      }

      return {
        success: true,
        questionnaireId: Number(questionnaire.id),
        submissionId: Number(submission.id),
      };
    });
  }
}
