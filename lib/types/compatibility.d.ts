import type { CompatibilityAdapter, DshRuntime, SkinEntry } from './types.ts';
type CompatibilitySkin = Pick<SkinEntry, 'compatibility'>;
export interface CompatibilityAssessment {
    decision: 'compatible' | 'adaptable' | 'unknown' | 'incompatible';
    reason: string;
    adapterIds: string[];
}
export declare function applicableAdapters(skin: CompatibilitySkin, runtime: DshRuntime, _legacyIncludeBuiltIns?: boolean): CompatibilityAdapter[];
export declare function assessCompatibility(skin: CompatibilitySkin, runtime: DshRuntime): CompatibilityAssessment;
export {};
