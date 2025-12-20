import { Controller, Get, Post, Put, Delete, Body, Param, ParseIntPipe } from '@nestjs/common';
import { RoleService } from './role.service';

@Controller('roles')
export class RoleController {
    constructor(private readonly roleService: RoleService) {}

    @Get()
    getRoles() {
        return this.roleService.getRoles();
    }

    @Post()
    createRole(@Body() data: any) {
        return this.roleService.createRole(data);
    }

    @Put(':id')
    updateRole(
        @Param('id', ParseIntPipe) id: number,
        @Body() data: any
    ) {
        return this.roleService.updateRole(id, data);
    }

    @Delete(':id')
    deleteRole(@Param('id', ParseIntPipe) id: number) {
        return this.roleService.deleteRole(id);
    }
}
