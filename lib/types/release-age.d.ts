export interface ReleaseAgeTarget {
    packageName: string;
    version: string;
}
/** Input to a precise local exemption must never be a selector, URL or command. */
export declare function parseReleaseAgeTarget(packageName: string, version: string): ReleaseAgeTarget | undefined;
export declare class ReleaseAgeConfigurationError extends Error {
    readonly code: 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target';
    constructor(code: 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target');
}
/** Merge only existing precise authorizations. Unsafe input stays byte-for-byte intact. */
export declare function repairReleaseAgeExcludes(profileDir: string): string[];
/** Persist an explicit user approval for exactly one package version. */
export declare function allowReleaseAgeVersion(profileDir: string, target: ReleaseAgeTarget): void;
