import type { SkinEntry } from './types.ts';
export type DesktopInstallSkin = Pick<SkinEntry, 'repo' | 'package' | 'subpath' | 'install' | 'review'>;
export type DesktopInstallPlan = {
    kind: 'npm' | 'github';
    target: string;
} | {
    kind: 'manual';
    reason: string;
};
/** Browser-safe policy shared by the market UI and the Host lifecycle. */
export declare function desktopInstallPlan(skin: DesktopInstallSkin, official: boolean): DesktopInstallPlan;
/** Also used when updating an existing GitHub source, even if npm is now available. */
export declare function desktopGithubInstallPlan(skin: DesktopInstallSkin): DesktopInstallPlan;
