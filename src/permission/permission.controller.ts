import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe } from '@nestjs/common';
import { PermissionService } from './permission.service';

@Controller('permissions')
export class PermissionController {
    constructor(private readonly permissionService: PermissionService) {}

    @Get('tree')
    getPermissionTree() {
        return this.permissionService.getPermissionTree();
    }

    @Post()
    createPermission(@Body() data: any) {
        return this.permissionService.createPermission(data);
    }

    @Delete(':id')
    deletePermission(@Param('id', ParseIntPipe) id: string) {
        return this.permissionService.deletePermission(+id);
    }
}
