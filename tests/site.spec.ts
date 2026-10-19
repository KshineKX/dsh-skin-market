import { describe, expect, it } from 'vitest'
import { MARKET_CLI_COMMAND, MARKET_DESKTOP_INPUT, MARKET_PROMPT, MARKET_REPOSITORY, MARKET_WEB_COMMAND, skinCommand, skinPrompt, skinWebCommand } from '../site/prompts.ts'
import type { CatalogSkin } from '../src/client/types.ts'

const skin = {
  repo: 'https://github.com/example/dsh-skin', package: 'example-skin', rowId: 'example-skin',
  install: { target: `github:example/dsh-skin#${'a'.repeat(40)}`, version: '1.0.0', commit: 'a'.repeat(40) },
} as CatalogSkin

describe('static catalog prompts', () => {
  it('generates the platform installation prompt', () => {
    expect(MARKET_PROMPT).toContain(MARKET_REPOSITORY)
    expect(MARKET_DESKTOP_INPUT).toBe('dsh-skin-market')
    expect(MARKET_CLI_COMMAND).toBe('dsh plugin --profile web add "dsh-skin-market"')
    expect(MARKET_CLI_COMMAND).toBe(MARKET_WEB_COMMAND)
    expect(MARKET_CLI_COMMAND).not.toContain('\n')
    expect(MARKET_CLI_COMMAND).not.toContain('#')
    expect(MARKET_CLI_COMMAND).not.toContain('--profile desktop')
    expect(MARKET_PROMPT).toContain('判断是 Web 版还是官方 Desktop')
    expect(MARKET_PROMPT).toContain('无法判断就先问我')
    expect(MARKET_PROMPT).toContain('不要执行 dsh plugin --profile desktop')
    expect(MARKET_PROMPT).toContain('无需先检查或停用其他皮肤')
    expect(MARKET_PROMPT).not.toContain('发现其他皮肤插件就列出并停下')
    const desktop = MARKET_PROMPT.split('- 官方 Desktop：')[1]!
    expect(desktop).toContain('你负责只读检查和逐步指导，我负责操作')
    expect(desktop).toContain('每次只给一个操作，等我反馈再继续')
    expect(desktop).toContain('未核实不能宣称成功')
    expect(desktop).not.toContain(MARKET_WEB_COMMAND)
  })

  it('routes manual Desktop skins to user operations while retaining Web installation', () => {
    const prompt = skinPrompt(skin)
    expect(prompt).toContain(`仓库：${skin.repo}`)
    expect(prompt).toContain(skin.install.target)
    expect(prompt).toContain('判断当前是 Web 版还是官方 Desktop')
    expect(prompt).toContain('不要执行 dsh plugin --profile desktop')
    expect(prompt).toContain('皮肤详情点击「安装」')
    expect(prompt).toContain('必须先完成只读冲突检查')
    expect(prompt).toContain('停在安装前')
    const desktop = prompt.split('\n\n官方 Desktop：')[1]!.split('\n\nWeb 版：')[0]!
    expect(desktop).toContain('「插件 → 添加插件」')
    expect(desktop).toContain('由我点击安装')
    expect(desktop).not.toContain('dsh plugin --profile web add')
  })

  it('adds a review-first guard to unverified skin prompts', () => {
    const prompt = skinPrompt({ ...skin, review: { compatibility: 'unverified', preview: 'verified', installation: 'manual-only' } })

    expect(prompt).toContain(`仓库：${skin.repo}`)
    expect(prompt).toContain('先只读检查仓库')
    expect(prompt).toContain('等待我确认后再安装')
    expect(prompt).toContain('不要直接安装')
  })

  it('generates a command for the catalog-pinned skin target', () => {
    const target = `github:example/dsh-skin#${'a'.repeat(40)}`
    const command = skinCommand(target)

    expect(command).toBe(`dsh plugin --profile web add "${target}"`)
    expect(command).not.toContain('\n')
    expect(command).not.toContain('--profile desktop')
  })

  it('leaves terminal-specific subdirectory installation to the Agent prompt', () => {
    const target = `github:example/dsh-skin#${'a'.repeat(40)}&path:/packages/skin`
    expect(skinWebCommand({ ...skin, install: { ...skin.install, target } })).toBeUndefined()
  })
})
