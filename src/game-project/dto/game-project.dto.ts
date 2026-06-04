import { OrderType, ProjectStatus, BillingMode } from '@prisma/client';

export class CreateGameProjectDto {
    name: string;
    price: number;
    originPrice?: number;
    type: string;
    gameType?: string;
    projectType?: string;
    category?: string;
    richContent?: string;
    showInMenuList?: boolean;

    billingMode?: BillingMode; // ✅ 新增：小时/保底，允许不传（后端会给默认）

    baseAmount?: number;
    clubRate?: number;
    coverImage?: string;
    description?: string;
}

export class UpdateGameProjectDto {
    price?: number;
    originPrice?: number;
    type?: OrderType;
    gameType?: string;
    projectType?: string;
    category?: string;
    richContent?: string;
    showInMenuList?: boolean;

    billingMode?: BillingMode; // ✅ 新增

    baseAmount?: number;
    clubRate?: number;
    coverImage?: string;
    description?: string;
    status?: ProjectStatus;
}
