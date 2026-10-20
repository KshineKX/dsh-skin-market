import { posix, win32 } from 'node:path';
/** Use the running host, never the browser connecting to it. */
export function getInstallEnvironment(profile, profileDir, platform = process.platform) {
    const path = platform === 'win32' ? win32 : posix;
    const directory = path.resolve(profileDir);
    const root = path.dirname(path.dirname(directory));
    const expected = path.join(root, 'profiles', profile);
    const cliAvailable = platform === 'win32' ? expected.toLowerCase() === directory.toLowerCase() : expected === directory;
    return {
        platform: platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'unknown',
        profile,
        profileDir: directory,
        cliAvailable,
        ...(cliAvailable ? { dshHome: root } : {}),
    };
}
