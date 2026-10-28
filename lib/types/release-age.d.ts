export interface ReleaseAgeTarget {
    packageName: string;
    version: string;
}
/** Input to a precise local exemption must never be a selector, URL or command. */
export declare function parseReleaseAgeTarget(packageName: string, version: string): ReleaseAgeTarget | undefined;
/** Read the observable pnpm fresh-release window; unknown config is not guessed. */
export declare function readMinimumReleaseAgeMs(profileDir: string): number | null;
/** Whether a precise local exception already allows this package version. */
export declare function isReleaseAgeExcluded(profileDir: string, packageName: string, version: string): boolean;
export declare class ReleaseAgeConfigurationError extends Error {
    readonly code: 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target';
    constructor(code: 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target');
}
/** Merge only existing precise authorizations. Unsafe input stays byte-for-byte intact. */
export declare function repairReleaseAgeExcludes(profileDir: string): string[];
/** Persist an explicit user approval for exactly one package version. */
export declare function allowReleaseAgeVersion(profileDir: string, target: ReleaseAgeTarget): void;
