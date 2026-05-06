import {Module} from '@nestjs/common';
import {AppController} from './app.controller';
import {AppService} from './app.service';
import { APP_GUARD } from '@nestjs/core';
import {PrismaService} from './prisma/prisma.service';
import {UsersModule} from './users/users.module';
import {OrdersModule} from './orders/orders.module';
import {AuthModule} from './auth/auth.module';
import {StaffRatingsModule} from './staff-ratings/staff-ratings.module';
import {SettlementsModule} from './settlements/settlements.module';
import {PermissionModule} from './permission/permission.module';
import {RoleModule} from './role/role.module';
import {GameProjectModule} from './game-project/game-project.module';
import {MetaModule} from './meta/meta.module';
import {ScheduleModule} from '@nestjs/schedule';
import {WalletModule} from './wallet/wallet.module';
import {DashboardModule} from "./dashboard/dashboard.module";
import {UserLogsModule} from './user-logs/user-logs.module';
import {FinanceModule} from './finance/finance.module';
import {UserStatusGuard} from './common/guards/user-status.guard';
import {JwtAuthGuard} from "./auth/guards/jwt-auth.guard";
import {PermissionsGuard} from "./auth/guards/permissions.guard";
import { PerformanceModule } from './performance/performance.module';
import { SystemConfigModule } from './system-config/system-config.module';
import { OfflineFeeModule } from './offline-fee/offline-fee.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CouponsModule } from './coupons/coupons.module';
import { PenaltiesModule } from './penalties/penalties.module';
import { AppVersionModule } from './app-version/app-version.module';
import { ChestModule } from './chest/chest.module';


@Module({
    imports: [
        UsersModule,
        OrdersModule,
        SettlementsModule,
        AuthModule,
        StaffRatingsModule,
        PermissionModule,
        RoleModule,
        GameProjectModule,
        ScheduleModule.forRoot(),
        WalletModule,
        DashboardModule,
        UserLogsModule,
        MetaModule,
        FinanceModule,
        PerformanceModule,
        SystemConfigModule,
        OfflineFeeModule,
        NotificationsModule,
        CouponsModule,
        PenaltiesModule,
    AppVersionModule,
    ChestModule,
  ],
    controllers: [AppController],
    providers: [AppService, PrismaService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },      // 1) 先验 token，挂 req.user
        { provide: APP_GUARD, useClass: UserStatusGuard },   // 2) 冻结/禁用限制
        { provide: APP_GUARD, useClass: PermissionsGuard },  // 3) 权限校验（读 @Permissions）
    ],
})
export class AppModule {
}
