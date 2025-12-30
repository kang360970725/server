import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
} from '@nestjs/common';
import { PermissionService } from './permission.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('permissions')
@UseGuards(JwtAuthGuard)
export class PermissionController {
    constructor(private readonly permissionService: PermissionService) {}

    @Get('tree')
    @UseGuards(PermissionsGuard)
    @Permissions('system:permission:page')
    getPermissionTree() {
        return this.permissionService.getPermissionTree();
    }

    @Post()
    @UseGuards(PermissionsGuard)
    @Permissions('system:permission:page')
    createPermission(@Body() data: any) {
        return this.permissionService.createPermission(data);
    }

    @Delete(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:permission:page')
    deletePermission(@Param('id', ParseIntPipe) id: string) {
        return this.permissionService.deletePermission(+id);
    }
}
