// utils/money/format.ts
export const fmtMoney = (n?: number | string | null) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '-';
    return `¥${x.toFixed(2)}`;
};

export const toNum = (v: any) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v?.toNumber === 'function') return v.toNumber();
    const s = typeof v === 'string' ? v : (typeof v?.toString === 'function' ? v.toString() : String(v));
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
};

/**
 * 金额安全取整（两位小数）
 * - 用于 rollback / 修复计算
 * - 避免浮点累计误差
 */
export const round2 = (v: number) => {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
};

/**
 * 金额规则：
 * - 正数：截断（不进位）
 * - 负数：四舍五入
 * - 保留 1 位小数
 */
export function roundMix1(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 0;

    // 正数：向 0 截断（舍弃）
    if (n > 0) {
        return Math.trunc(n * 10) / 10;
    }

    // 负数：四舍五入
    return Math.round((n + Number.EPSILON) * 10) / 10;
}

export const groupByUserId = (rows: any[]) => {
    return rows.reduce((acc: Record<number, any[]>, row: any) => {
        const uid = Number(row.userId);
        if (!acc[uid]) acc[uid] = [];
        acc[uid].push(row);
        return acc;
    }, {});
};
