import type { InstallEnvironment } from './install-command.ts';
/** Use the running host, never the browser connecting to it. */
export declare function getInstallEnvironment(profile: string, profileDir: string, platform?: string): InstallEnvironment;
