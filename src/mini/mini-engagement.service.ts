import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {MemberPointBizType} from '@prisma/client';
import {MemberService} from '../member/member.service';
import {SystemConfigService} from '../system-config/system-config.service';

const achievements = [
  {code: 'WELCOME', name: '初来乍到', description: '完成会员登录', rarity: 'COMMON', target: 1, icon: '👋'},
  {code: 'PROFILE_READY', name: '身份认证', description: '完善昵称、头像和手机号', rarity: 'COMMON', target: 1, icon: '🪪'},
  {code: 'GAME_PLAYER', name: '游戏玩家', description: '创建第一张游戏名片', rarity: 'RARE', target: 1, icon: '🎮'},
  {code: 'EXPLORER', name: '探索者', description: '浏览 5 项不同服务', rarity: 'RARE', target: 5, icon: '🧭'},
  {code: 'COLLECTOR', name: '收藏达人', description: '收藏 5 项喜欢的服务', rarity: 'EPIC', target: 5, icon: '💎'},
  {code: 'CHECKIN_STAR', name: '签到新星', description: '累计签到 3 天', rarity: 'RARE', target: 3, icon: '⭐'},
  {code: 'SEVEN_DAY', name: '七日之约', description: '连续签到 7 天', rarity: 'LEGENDARY', target: 7, icon: '🔥'},
  {code: 'DEEP_EXPLORER', name: '深度探索者', description: '浏览 20 项不同服务', rarity: 'EPIC', target: 20, icon: '🔭'},
  {code: 'TREASURE_KEEPER', name: '珍藏家', description: '收藏 10 项喜欢的服务', rarity: 'LEGENDARY', target: 10, icon: '👑'},
  {code: 'MONTH_KEEPER', name: '月光守望者', description: '累计签到 30 天', rarity: 'EPIC', target: 30, icon: '🌙'},
  {code: 'FIRST_SERVICE', name: '并肩作战', description: '拥有第一条服务记录', rarity: 'RARE', target: 1, icon: '🤝'},
  {code: 'OLD_FRIEND', name: '蓝猫老友', description: '加入会员满 30 天', rarity: 'EPIC', target: 30, icon: '🐾'},
  {code: 'DAWN_CALLER', name: '破晓召唤师', description: '在清晨完成一次签到', rarity: 'EPIC', target: 1, icon: '🌅', hidden: true},
  {code: 'NIGHT_WATCHER', name: '暗夜守望者', description: '在深夜完成一次签到', rarity: 'EPIC', target: 1, icon: '🌌', hidden: true},
  {code: 'SERVICE_CREATOR', name: '星光服务者', description: '服务者公开名片通过审核', rarity: 'LEGENDARY', target: 1, icon: '✨', hidden: true},
] as const;

const memberThemes: Record<string, any> = {
  V0:{code:'V0',name:'初见会员',primary:'#64748b',secondary:'#94a3b8',background:'#f5f7fa',card:'#ffffff',gradient:'linear-gradient(135deg,#475569 0%,#7c8999 55%,#a8b2bf 130%)'},
  V1:{code:'V1',name:'储值会员',primary:'#2563eb',secondary:'#38bdf8',background:'#f3f7ff',card:'#ffffff',gradient:'linear-gradient(135deg,#153c91 0%,#2563eb 55%,#38bdf8 130%)'},
  V2:{code:'V2',name:'黄金会员',primary:'#b7791f',secondary:'#f6c453',background:'#fffaf0',card:'#fffdf8',gradient:'linear-gradient(135deg,#775015 0%,#b7791f 42%,#f6c453 105%)'},
  V3:{code:'V3',name:'黑金会员',primary:'#8a6728',secondary:'#c49a4a',background:'#f7f4ed',card:'#fffefa',gradient:'linear-gradient(135deg,#111111 0%,#3b3121 50%,#c49a4a 125%)'},
  V4:{code:'V4',name:'铂金会员',primary:'#536b7c',secondary:'#d9e8ed',background:'#f1f6f8',card:'#fbfdfe',gradient:'linear-gradient(125deg,#263746 0%,#647b8d 30%,#d9e8ed 53%,#87a7af 69%,#344b5b 100%)'},
  V5:{code:'V5',name:'钻石会员',primary:'#6557d9',secondary:'#50bde8',background:'#f3f5ff',card:'#ffffff',gradient:'linear-gradient(122deg,#101a4b 0%,#283b8f 24%,#7868d9 46%,#d5efff 58%,#50bde8 70%,#263b93 100%)'},
  V6:{code:'V6',name:'星耀会员',primary:'#b52fd2',secondary:'#ffb84c',background:'#fff3fb',card:'#ffffff',gradient:'linear-gradient(125deg,#17052f 0%,#4b126f 24%,#a51eaa 47%,#ff4f9a 65%,#ffb84c 82%,#4b1b78 112%)'},
};

function dayStart(value = new Date()) {
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

@Injectable()
export class MiniEngagementService {
  constructor(private readonly prisma: PrismaService, private readonly memberService: MemberService, private readonly systemConfig: SystemConfigService) {}

  private async assertProfileCompleted(userId: number) {
    if (!userId) throw new BadRequestException('请先完成微信授权登录');
    const user = await this.prisma.user.findUnique({
      where: {id: userId},
      select: {name: true, avatar: true, phone: true},
    });
    const completed = Boolean(
      user?.name?.trim()
      && user?.avatar?.trim()
      && user?.phone?.trim()
      && !user.phone.startsWith('wx_'),
    );
    if (!completed) throw new BadRequestException('请先完善昵称、头像和手机号');
  }

  private async metrics(userId: number) {
    const today = dayStart();
    const [user, gameCards, favoriteCount, views, checkins, todayFavorite, orderCount, staffCard, profile] = await Promise.all([
      this.prisma.user.findUnique({where: {id: userId}, select: {name: true, avatar: true, phone: true, createdAt: true, userType: true}}),
      this.prisma.memberGameCard.findMany({where: {userId}, orderBy: [{isPrimary: 'desc'}, {createdAt: 'asc'}]}),
      this.prisma.memberProjectFavorite.count({where: {userId}}),
      this.prisma.memberProjectView.findMany({where: {userId}, select: {projectId: true, viewedOn: true}, orderBy: {lastViewedAt: 'desc'}}),
      this.prisma.memberCheckin.findMany({where: {userId}, orderBy: {checkinDate: 'desc'}, take: 100}),
      this.prisma.memberProjectFavorite.count({where: {userId, createdAt: {gte: today}}}),
      this.prisma.order.count({where: {customerUserId: userId}}),
      this.prisma.staffPublicCard.findUnique({where: {userId}}),
      this.prisma.memberProfile.findUnique({where: {userId}}),
    ]);
    const uniqueViews = new Set(views.map((x) => x.projectId)).size;
    let streak = 0;
    let cursor = today.getTime();
    const days = new Set(checkins.map((x) => dayStart(x.checkinDate).getTime()));
    if (!days.has(cursor)) cursor -= 86400000;
    while (days.has(cursor)) { streak += 1; cursor -= 86400000; }
    return {
      user, gameCards, favoriteCount, uniqueViews, checkinCount: checkins.length, streak,
      checkedToday: days.has(today.getTime()),
      viewedToday: views.some((x) => dayStart(x.viewedOn).getTime() === today.getTime()),
      favoritedToday: todayFavorite > 0,
      orderCount, staffCard, profile,
      dawnCheckin: checkins.some((x) => x.createdAt.getHours() >= 5 && x.createdAt.getHours() < 9),
      nightCheckin: checkins.some((x) => x.createdAt.getHours() < 5 || x.createdAt.getHours() >= 23),
    };
  }

  async dashboard(userId: number) {
    const m = await this.metrics(userId);
    const profileReady = Boolean(m.user?.name && m.user?.avatar && m.user?.phone && !m.user.phone.startsWith('wx_'));
    const progress: Record<string, number> = {
      WELCOME: profileReady ? 1 : 0,
      PROFILE_READY: profileReady ? 1 : 0,
      GAME_PLAYER: m.gameCards.length,
      EXPLORER: m.uniqueViews,
      COLLECTOR: m.favoriteCount,
      CHECKIN_STAR: m.checkinCount,
      SEVEN_DAY: m.streak,
      DEEP_EXPLORER: m.uniqueViews, TREASURE_KEEPER: m.favoriteCount, MONTH_KEEPER: m.checkinCount,
      FIRST_SERVICE: m.orderCount,
      OLD_FRIEND: Math.max(0, Math.floor((Date.now() - Number(m.user?.createdAt || Date.now())) / 86400000)),
      DAWN_CALLER: m.dawnCheckin ? 1 : 0, NIGHT_WATCHER: m.nightCheckin ? 1 : 0,
      SERVICE_CREATOR: m.staffCard?.status === 'APPROVED' ? 1 : 0,
    };
    const unlockedCodes = profileReady
      ? achievements.filter((x) => progress[x.code] >= x.target).map((x) => x.code)
      : [];
    await Promise.all(unlockedCodes.map((code) => this.prisma.memberAchievement.upsert({
      where: {userId_code: {userId, code}}, update: {}, create: {userId, code},
    })));
    const unlocked = await this.prisma.memberAchievement.findMany({where: {userId}, orderBy: {unlockedAt: 'desc'}});
    const unlockedMap = new Map(unlocked.map((x) => [x.code, x.unlockedAt]));
    const achievementList = achievements.map((item: any) => { const isUnlocked=profileReady&&unlockedMap.has(item.code); return {...item,name:item.hidden&&!isUnlocked?'隐藏成就':item.name,description:item.hidden&&!isUnlocked?'达成神秘条件后揭晓':item.description,icon:item.hidden&&!isUnlocked?'❔':item.icon,progress:profileReady?(item.hidden&&!isUnlocked?0:Math.min(progress[item.code]||0,item.target)):0,unlocked:isUnlocked,unlockedAt:isUnlocked?unlockedMap.get(item.code)||null:null}; });
    const signInPoints=Math.max(0,Math.min(100,Math.floor(Number(await this.systemConfig.getNumber(SystemConfigService.KEYS.MINI_MEMBER_SIGNIN_POINTS,1)||0))));
    const tasks = [
      {code: 'CHECKIN', name: '每日签到', description: '签到点亮今日足迹', completed: m.checkedToday, action: '/pages/checkin/index', reward: signInPoints},
      {code: 'BROWSE', name: '探索服务', description: '浏览任意一项服务', completed: m.viewedToday, action: '/pages/search-results/index', reward: 0},
      {code: 'FAVORITE', name: '收藏心仪服务', description: '收藏一项喜欢的服务', completed: m.favoritedToday, action: '/pages/search-results/index', reward: 0},
      {code: 'GAME_CARD', name: '完善游戏身份', description: '创建你的游戏名片', completed: m.gameCards.length > 0, action: '/pages/membership-growth/index', reward: 0},
    ];
    return {
      tasks, taskCompleted: tasks.filter((x) => x.completed).length,
      achievements: achievementList, unlockedCount: achievementList.filter((x) => x.unlocked).length,
      favoriteCount: m.favoriteCount, streak: m.streak, primaryGameCard: m.gameCards[0] || null,
      staffCard: m.staffCard || null,
      signInPoints,
      memberTheme: memberThemes[String(m.profile?.levelCode || 'V0').toUpperCase()] || memberThemes.V0,
    };
  }

  async checkin(userId: number) {
    await this.assertProfileCompleted(userId);
    const today = dayStart();
    const existing = await this.prisma.memberCheckin.findUnique({where: {userId_checkinDate: {userId, checkinDate: today}}});
    if (!existing) {
      const created = await this.prisma.memberCheckin.create({data: {userId, checkinDate: today}});
      const configured=await this.systemConfig.getNumber(SystemConfigService.KEYS.MINI_MEMBER_SIGNIN_POINTS,1);
      const points=Math.max(0,Math.min(100,Math.floor(Number(configured||0))));
      if(points>0) await this.memberService.addPoints({userId,points,bizType:MemberPointBizType.SIGN_IN,sourceType:'MEMBER_CHECKIN',sourceId:created.id,remark:'每日签到奖励'});
    }
    return this.dashboard(userId);
  }

  async recordView(userId: number, projectId: number) {
    await this.assertProfileCompleted(userId);
    await this.assertProject(projectId);
    const viewedOn = dayStart();
    await this.prisma.memberProjectView.upsert({
      where: {userId_projectId_viewedOn: {userId, projectId, viewedOn}},
      update: {viewCount: {increment: 1}, lastViewedAt: new Date()}, create: {userId, projectId, viewedOn},
    });
    return {success: true};
  }

  async favoriteState(userId: number, projectId: number) {
    return {favorited: !!(await this.prisma.memberProjectFavorite.findUnique({where: {userId_projectId: {userId, projectId}}}))};
  }

  async toggleFavorite(userId: number, projectId: number) {
    await this.assertProfileCompleted(userId);
    await this.assertProject(projectId);
    const existing = await this.prisma.memberProjectFavorite.findUnique({where: {userId_projectId: {userId, projectId}}});
    if (existing) await this.prisma.memberProjectFavorite.delete({where: {id: existing.id}});
    else await this.prisma.memberProjectFavorite.create({data: {userId, projectId}});
    return {favorited: !existing};
  }

  async favorites(userId: number) {
    return this.prisma.memberProjectFavorite.findMany({where: {userId}, include: {project: true}, orderBy: {createdAt: 'desc'}});
  }

  async myStaffCard(userId:number){const user=await this.prisma.user.findUnique({where:{id:userId},select:{userType:true,name:true,avatar:true}});const type=String(user?.userType||'').toUpperCase();if(!['STAFF','SUPER_ADMIN'].includes(type))return{eligible:false,card:null};return{eligible:true,card:await this.prisma.staffPublicCard.findUnique({where:{userId}}),defaults:{displayName:user?.name,avatarUrl:user?.avatar}};}
  async saveMyStaffCard(userId:number,body:any){const own=await this.myStaffCard(userId);if(!own.eligible)throw new BadRequestException('仅服务者可维护公开名片');const displayName=String(body?.displayName||'').trim().slice(0,64);if(!displayName)throw new BadRequestException('请填写展示名称');const submit=body?.submit===true;return this.prisma.staffPublicCard.upsert({where:{userId},update:{displayName,avatarUrl:String(body?.avatarUrl||'').trim()||null,slogan:String(body?.slogan||'').trim().slice(0,120)||null,bio:String(body?.bio||'').trim()||null,gameTags:Array.isArray(body?.gameTags)?body.gameTags:[],skillTags:Array.isArray(body?.skillTags)?body.skillTags:[],serviceYears:Math.max(0,Math.min(50,Number(body?.serviceYears||0))),status:submit?'PENDING':'DRAFT',submittedAt:submit?new Date():null,reviewRemark:null},create:{userId,displayName,avatarUrl:String(body?.avatarUrl||'').trim()||null,slogan:String(body?.slogan||'').trim().slice(0,120)||null,bio:String(body?.bio||'').trim()||null,gameTags:Array.isArray(body?.gameTags)?body.gameTags:[],skillTags:Array.isArray(body?.skillTags)?body.skillTags:[],serviceYears:Math.max(0,Math.min(50,Number(body?.serviceYears||0))),status:submit?'PENDING':'DRAFT',submittedAt:submit?new Date():null}});}
  async approvedStaffCards(){return this.prisma.staffPublicCard.findMany({where:{status:'APPROVED'},orderBy:{reviewedAt:'desc'},take:50});}
  async adminStaffCards(status?:string){return this.prisma.staffPublicCard.findMany({where:status?{status}:undefined,include:{user:{select:{id:true,name:true,phone:true,userType:true}}},orderBy:{updatedAt:'desc'}});}
  async reviewStaffCard(id:number,body:any,reviewerId:number){const status=String(body?.status||'').toUpperCase();if(!['APPROVED','REJECTED'].includes(status))throw new BadRequestException('审核状态无效');return this.prisma.staffPublicCard.update({where:{id},data:{status,reviewRemark:String(body?.reviewRemark||'').trim().slice(0,255)||null,reviewedAt:new Date(),reviewedBy:reviewerId||null}});}

  private async assertProject(projectId: number) {
    if (!projectId) throw new BadRequestException('商品ID无效');
    if (!await this.prisma.gameProject.findUnique({where: {id: projectId}, select: {id: true}})) throw new NotFoundException('商品不存在');
  }
}
