import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Prisma, UserType } from '@prisma/client';

export const tournamentMemberEligibilitySelect = {
    userType: true,
    memberProfile: { select: { memberCode: true } },
} satisfies Prisma.UserSelect;

type TournamentMember = Prisma.UserGetPayload<{ select: typeof tournamentMemberEligibilitySelect }>;

export function canMemberEnterTournament(member: TournamentMember | null): boolean {
    if (!member) return false;
    if (member.userType !== UserType.STAFF) return true;

    const code = member.memberProfile?.memberCode;
    const databaseUrl = process.env.DATABASE_URL;
    if (!code || !databaseUrl) return false;

    try {
        const database = new URL(databaseUrl);
        if (database.protocol !== 'mysql:' ||
            !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
            database.pathname !== '/bluecat_prodclone' ||
            database.searchParams.has('socket')) return false;

        // An already-running local IDEA process may predate the .env.prodclone change.
        const configuredCodes = process.env.LIVE_TOURNAMENT_TEST_MEMBER_CODES ??
            parseEnv(readFileSync('.env.prodclone', 'utf8')).LIVE_TOURNAMENT_TEST_MEMBER_CODES;
        return configuredCodes?.split(',').some(configuredCode => configuredCode.trim() === code) ?? false;
    } catch {
        return false;
    }
}
