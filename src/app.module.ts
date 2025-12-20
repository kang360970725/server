import {Module} from '@nestjs/common';
import {AppController} from './app.controller';
import {AppService} from './app.service';
import {PrismaService} from './prisma/prisma.service';
import {UsersModule} from './users/users.module';
import {OrdersModule} from './orders/orders.module';
import {AuthModule} from './auth/auth.module';
import {StaffRatingsModule} from './staff-ratings/staff-ratings.module';
import {PermissionModule} from './permission/permission.module';
import {RoleModule} from './role/role.module';
import {GameProjectModule} from './game-project/game-project.module';

@Module({
    imports: [
        UsersModule,
        OrdersModule,
        AuthModule,
        StaffRatingsModule,
        PermissionModule,
        RoleModule,
        GameProjectModule
    ],
    controllers: [AppController],
    providers: [AppService, PrismaService],
})
export class AppModule {
}
