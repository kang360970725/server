export type StaffResponseStat = {
  averageResponseSeconds: number | null;
  responseSampleCount: number;
  averageResponseTimeText: string;
};

export const formatResponseTime = (secondsInput: number | null | undefined, fallback = '暂无数据') => {
  if (secondsInput === null || secondsInput === undefined) return fallback;
  const seconds = Number(secondsInput);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  if (minutes < 60) return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}小时${remainMinutes}分钟` : `${hours}小时`;
};

export const formatEstimatedWaitTime = (secondsInput: number | null | undefined, fallback = '5-10分钟') => {
  if (secondsInput === null || secondsInput === undefined) return fallback;
  const seconds = Number(secondsInput);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  return `约${Math.max(1, Math.ceil(seconds / 60))}分钟`;
};

export async function buildStaffResponseStats(prisma: any, userIdsInput: number[]) {
  const userIds = Array.from(new Set((userIdsInput || []).map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  const result = new Map<number, StaffResponseStat>();
  if (!userIds.length) return result;

  const participants = await prisma.orderParticipant.findMany({
    where: {
      userId: {in: userIds},
      acceptedAt: {not: null},
      rejectedAt: null,
      dispatch: {assignedAt: {not: null}},
    },
    select: {
      userId: true,
      acceptedAt: true,
      dispatch: {select: {assignedAt: true}},
    },
  });

  const aggregates = new Map<number, {totalSeconds: number; count: number}>();
  for (const participant of participants) {
    const assignedAt = participant?.dispatch?.assignedAt ? new Date(participant.dispatch.assignedAt).getTime() : NaN;
    const acceptedAt = participant?.acceptedAt ? new Date(participant.acceptedAt).getTime() : NaN;
    const seconds = Math.round((acceptedAt - assignedAt) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const current = aggregates.get(Number(participant.userId)) || {totalSeconds: 0, count: 0};
    current.totalSeconds += seconds;
    current.count += 1;
    aggregates.set(Number(participant.userId), current);
  }

  for (const userId of userIds) {
    const aggregate = aggregates.get(userId);
    const averageResponseSeconds = aggregate?.count ? Math.round(aggregate.totalSeconds / aggregate.count) : null;
    result.set(userId, {
      averageResponseSeconds,
      responseSampleCount: aggregate?.count || 0,
      averageResponseTimeText: formatResponseTime(averageResponseSeconds),
    });
  }
  return result;
}
