import type { CompatibilityAssessment } from './compatibility.ts';
import type { DshRuntime, SkinEntry } from './types.ts';
export { assessCompatibility } from './compatibility.ts';
export type { CompatibilityAssessment } from './compatibility.ts';
export type CompatibilityDecision = CompatibilityAssessment['decision'];
export interface CompatibilityPatchPlan {
    patchFile: string;
    patchRelativePath: string;
    packageName: string;
    packageVersion: string;
    originalSource: string;
    patchedSource: string;
    relativeSourcePath: string;
    adapterIds: string[];
    matchedAdapterIds: string[];
    outcomes: Array<{
        adapterId: string;
        status: 'already-correct' | 'patchable';
    }>;
}
export declare function planCompatibilityPatch(profileDir: string, skin: SkinEntry, runtime: DshRuntime): CompatibilityPatchPlan | null;
export declare function unifiedPatch(relativeSourcePath: string, original: string, patched: string): string;
export declare function persistCompatibilityPatch(profileDir: string, plan: CompatibilityPatchPlan): void;
