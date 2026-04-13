import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type RealtimeNotificationItem = {
  id: string;
  type: string;
  title: string;
  content: string;
  route?: string;
  payload?: any;
  createdAt: string;
};

@Injectable()
export class RealtimeNotificationsService {
  // 每个用户仅保留最近 N 条实时消息（内存缓存，不持久化）
  private readonly maxCachePerUser = 200;

  // userId -> 消息列表
  private readonly cache = new Map<number, RealtimeNotificationItem[]>();

  // userId -> SSE 连接集合
  private readonly streams = new Map<number, Set<Subject<any>>>();

  private nextId(userId: number) {
    return `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  subscribe(userId: number): Observable<any> {
    const uid = Number(userId);
    const subject = new Subject<any>();

    if (!this.streams.has(uid)) this.streams.set(uid, new Set());
    this.streams.get(uid)!.add(subject);

    // 建连后主动推一次当前缓存，保证刷新页面也能看到未清空消息
    const snapshot = this.list(uid);
    subject.next({ type: 'snapshot', items: snapshot, unreadCount: snapshot.length });

    return new Observable((subscriber) => {
      const sub = subject.subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        const set = this.streams.get(uid);
        if (!set) return;
        set.delete(subject);
        if (!set.size) this.streams.delete(uid);
      };
    });
  }

  list(userId: number) {
    return [...(this.cache.get(Number(userId)) || [])].sort((a, b) => (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ));
  }

  clearOne(userId: number, id: string) {
    const uid = Number(userId);
    const list = this.cache.get(uid) || [];
    const next = list.filter((item) => item.id !== id);
    this.cache.set(uid, next);
    this.emitSystem(uid, { type: 'clear_one', id, unreadCount: next.length });
    return { success: true, unreadCount: next.length };
  }

  clearAll(userId: number) {
    const uid = Number(userId);
    this.cache.set(uid, []);
    this.emitSystem(uid, { type: 'clear_all', unreadCount: 0 });
    return { success: true, unreadCount: 0 };
  }

  pushToUsers(input: {
    userIds: number[];
    type: string;
    title: string;
    content: string;
    route?: string;
    payload?: any;
  }) {
    const uniqUserIds = Array.from(new Set((input.userIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
    if (!uniqUserIds.length) return { pushed: 0 };

    for (const userId of uniqUserIds) {
      const item: RealtimeNotificationItem = {
        id: this.nextId(userId),
        type: String(input.type || 'CUSTOM'),
        title: String(input.title || '消息通知'),
        content: String(input.content || ''),
        route: input.route || undefined,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      };

      const oldList = this.cache.get(userId) || [];
      const next = [item, ...oldList].slice(0, this.maxCachePerUser);
      this.cache.set(userId, next);

      this.emitData(userId, {
        type: 'message',
        item,
        unreadCount: next.length,
      });
    }

    return { pushed: uniqUserIds.length };
  }

  private emitData(userId: number, data: any) {
    const set = this.streams.get(Number(userId));
    if (!set || !set.size) return;
    for (const stream of set) {
      stream.next({ data });
    }
  }

  private emitSystem(userId: number, data: any) {
    this.emitData(userId, data);
  }
}
