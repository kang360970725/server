import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
} from '@nestjs/common';
import { RoleService } from './role.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('roles')
@UseGuards(JwtAuthGuard)
export class RoleController {
    constructor(private readonly roleService: RoleService) {}

    @Get()
    @UseGuards(PermissionsGuard)
    @Permissions('system:role:page')
    getRoles() {
        return this.roleService.getRoles();
    }

    @Post()
    @UseGuards(PermissionsGuard)
    @Permissions('system:role:page')
    createRole(@Body() data: any) {
        return this.roleService.createRole(data);
    }

    @Put(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:role:page')
    updateRole(
        @Param('id', ParseIntPipe) id: number,
        @Body() data: any,
    ) {
        return this.roleService.updateRole(id, data);
    }

    @Delete(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:role:page')
    deleteRole(@Param('id', ParseIntPipe) id: number) {
        return this.roleService.deleteRole(id);
    }
}
