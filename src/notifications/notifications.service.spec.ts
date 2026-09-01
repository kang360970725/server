import { NotificationsService } from './notifications.service';

describe('NotificationsService announcement force-read rules', () => {
  it('keeps recurring announcements and only unread first-force announcements', async () => {
    const service = Object.create(NotificationsService.prototype) as NotificationsService;
    jest.spyOn(service, 'listMyAnnouncements').mockResolvedValue([
      { id: 1, forceRead: true, forceReadOnce: false, isRead: true },
      { id: 2, forceRead: false, forceReadOnce: true, isRead: false },
      { id: 3, forceRead: false, forceReadOnce: true, isRead: true },
      { id: 4, forceRead: false, forceReadOnce: false, isRead: false },
    ] as any);

    const result = await service.getMyForceAnnouncementStats(9);

    expect(result.list.map((item: any) => item.id)).toEqual([1, 2]);
    expect(result.unreadForceCount).toBe(2);
  });
});
