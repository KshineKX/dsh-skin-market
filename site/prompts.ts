import { createDshPluginAddCommand, createInstallCommand } from '../src/install-command.ts'
import { createSkinInstallPrompt } from '../src/client/submission.ts'
import type { CatalogSkin } from '../src/client/types.ts'

export const MARKET_REPOSITORY = 'https://github.com/kingOfSoySauce/dsh-skin-market'
export const MARKET_PUBLIC_URL = 'https://kingofsoysauce.github.io/dsh-skin-market/'
export const MARKET_WEB_COMMAND = createDshPluginAddCommand('dsh-skin-market@latest')
export const MARKET_DESKTOP_INPUT = 'dsh-skin-market@latest'
export const MARKET_CLI_COMMAND = [
  '# Web 版',
  MARKET_WEB_COMMAND,
  '',
  '# 官方桌面版：不要在终端执行；在桌面应用「插件 → 添加插件」中输入并启用',
  MARKET_DESKTOP_INPUT,
].join('\n')
export { CLI_INSTALL_WARNING } from '../src/client/submission.ts'

export const MARKET_PROMPT = `请帮我安装 dsh-skin-market。先判断是 Web 版还是官方 Desktop，并核对当前宿主的实际 profile；无法判断就先问我。Web 查看 dsh --version；Desktop 以应用“关于”中的版本为准，不用系统终端的 npm dsh 版本代表桌面版本。不要读取 .env、凭据或其他存放秘密的配置。

这里只安装皮肤市场管理插件，不启用具体皮肤；无需先检查或停用其他皮肤，不要因为已有皮肤而阻断安装。
- Web 版：执行 ${MARKET_WEB_COMMAND}，安装后验证同一 Web profile 中有 dsh-skin-market 的依赖和 bundle。
- 官方 Desktop：你负责只读检查和逐步指导，我负责操作。不要执行 dsh plugin --profile desktop，不要用 npm/pnpm 写入 Desktop profile，也不要修改 profile。指导我打开桌面应用「插件 → 添加插件」，输入 ${MARKET_DESKTOP_INPUT}，由我点击安装并按应用提示启用。每次只给一个操作，等我反馈再继续。安装后只读核对插件页的安装结果；读不到时请我提供状态，未核实不能宣称成功。

告诉我重启哪个宿主、从哪里打开「设置 → 皮肤市场」。Desktop 需要重启时，指导我完全退出应用再重新打开。不要替我安装、停用或卸载其他皮肤。

仓库：${MARKET_REPOSITORY}`

export function skinPrompt(skin: CatalogSkin): string {
  return createSkinInstallPrompt(skin)
}

export function skinCommand(installTarget: string): string {
  return [
    '# Web 版',
    createInstallCommand(installTarget),
    '',
    '# 官方桌面版：不要在终端执行；在桌面应用「设置 → 皮肤市场」中打开该皮肤并安装',
  ].join('\n')
}
