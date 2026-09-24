import { SetMetadata } from '@nestjs/common';

export const MINI_FEATURE_KEY = 'miniFeature';
export const MiniFeature = (feature: string) => SetMetadata(MINI_FEATURE_KEY, feature);
