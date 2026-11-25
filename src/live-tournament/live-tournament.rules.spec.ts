import { drawTournamentProvider } from './live-tournament.rules';

describe('tournament provider draw', () => {
    it('avoids the previous provider while another valid provider is available', () => {
        const quotas = [
            {providerId: 1, minimum: 0, maximum: 2, drawn: 1},
            {providerId: 2, minimum: 0, maximum: 2, drawn: 0},
        ];
        expect(drawTournamentProvider(quotas, 3, 1)).toBe(2);
    });

    it('allows a consecutive draw only when quota feasibility requires it', () => {
        const quotas = [
            {providerId: 1, minimum: 2, maximum: 2, drawn: 0},
            {providerId: 2, minimum: 0, maximum: 2, drawn: 0},
        ];
        expect(drawTournamentProvider(quotas, 2, 1)).toBe(1);
    });

    it('never selects a provider who has reached the configured maximum', () => {
        const quotas = [
            {providerId: 1, minimum: 0, maximum: 2, drawn: 2},
            {providerId: 2, minimum: 0, maximum: 2, drawn: 1},
        ];
        expect(drawTournamentProvider(quotas, 1, 2)).toBe(2);
    });

    it('hard-excludes the provider being replaced during a redraw', () => {
        const quotas = [
            {providerId: 1, minimum: 0, maximum: 2, drawn: 0},
            {providerId: 2, minimum: 0, maximum: 2, drawn: 0},
        ];
        expect(drawTournamentProvider(quotas, 1, null, [1])).toBe(2);
    });

    it('rejects a redraw when no different provider can satisfy the quota', () => {
        const quotas = [{providerId: 1, minimum: 0, maximum: 2, drawn: 0}];
        expect(() => drawTournamentProvider(quotas, 1, null, [1]))
            .toThrow('暂无其他符合配额的服务者');
    });
});
