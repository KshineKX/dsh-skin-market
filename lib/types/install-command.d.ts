export type InstallShell = 'posix' | 'powershell' | 'cmd';
export interface InstallEnvironment {
    platform: 'win32' | 'darwin' | 'linux' | 'unknown';
    profile: string;
    profileDir: string;
    dshHome?: string;
    cliAvailable?: boolean;
}
export interface InstallCommandContext {
    shell?: InstallShell;
    profile?: string;
    profileDir?: string;
    dshHome?: string;
    cliAvailable?: boolean;
}
/** Catalog targets contain no shell expansion, even inside double quotes. */
export declare function quoteInstallTarget(target: string): string;
export declare function createDshPluginAddCommand(target: string, profile?: string, context?: InstallCommandContext): string;
/** One shell-specific executable command; platform descriptions stay in the UI. */
export declare function createInstallCommand(target: string, profile?: string, context?: InstallCommandContext): string;
