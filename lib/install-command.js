/** Catalog targets contain no shell expansion, even inside double quotes. */
export function quoteInstallTarget(target) {
    if (!/^[A-Za-z0-9@._:/#&+=,-]+$/.test(target))
        throw new Error('install target contains unsupported command characters');
    return `"${target}"`;
}
function quoteArgument(value, shell) {
    if (/[\u0000\r\n]/.test(value))
        throw new Error('command argument contains unsupported characters');
    if (shell === 'posix')
        return "'" + value.replaceAll("'", "'\\''") + "'";
    if (shell === 'powershell')
        return "'" + value.replaceAll("'", "''") + "'";
    // cmd expands these characters even in quotes; PowerShell can represent them literally.
    if (/["%!]/.test(value))
        throw new Error('command argument cannot be represented safely in CMD');
    return `"${value}"`;
}
export function createDshPluginAddCommand(target, profile = 'web', context = {}) {
    const shell = context.shell ?? 'posix';
    const selectedProfile = context.profile ?? profile;
    const quotedProfile = /^[A-Za-z0-9_-]+$/.test(selectedProfile) ? selectedProfile : quoteArgument(selectedProfile, shell);
    const command = `dsh plugin --profile ${quotedProfile} add ${quoteInstallTarget(target)}`;
    if (context.dshHome === undefined)
        return command;
    const home = quoteArgument(context.dshHome, shell);
    if (shell === 'posix')
        return `DSH_HOME=${home} ${command}`;
    if (shell === 'powershell')
        return `$env:DSH_HOME = ${home}; ${command}`;
    return `set "DSH_HOME=${context.dshHome}" && ${command}`;
}
/** One shell-specific executable command; platform descriptions stay in the UI. */
export function createInstallCommand(target, profile = 'web', context = {}) {
    const selectedProfile = context.profile ?? profile;
    if (!target.includes('&')) {
        const exactNpm = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(target);
        return `${createDshPluginAddCommand(target, selectedProfile, context)}${exactNpm ? ' --save-exact' : ''}`;
    }
    const shell = context.shell ?? 'posix';
    if (context.profileDir === undefined && !/^[A-Za-z0-9_-]+$/.test(selectedProfile))
        throw new Error('profile requires an explicit directory');
    const directory = context.profileDir !== undefined
        ? quoteArgument(context.profileDir, shell)
        : shell === 'powershell' ? `"$env:USERPROFILE\\.dsh\\profiles\\${selectedProfile}"`
            : shell === 'cmd' ? `"%USERPROFILE%\\.dsh\\profiles\\${selectedProfile}"`
                : `"$HOME/.dsh/profiles/${selectedProfile}"`;
    return `pnpm add ${quoteInstallTarget(target)} --dir ${directory}`;
}
