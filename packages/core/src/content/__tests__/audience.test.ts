/** Audience fast paths must preserve exact source bytes and privacy semantics. */
import { describe, expect, it } from 'vitest'
import { projectMdxAudience } from '../audience'

describe('audience projection', () => {
  it.each(['humans', 'agents'] as const)('preserves unmarked Unicode source exactly for %s', (audience) => {
    const source = '# Café 中文 👩🏽‍💻\r\n\r\nİstanbul e\u0301 and `<Widget />`.\r\n\r\n```ts\r\nconst x = "{safe}"\r\n```\r\n'
    expect(projectMdxAudience(source, audience)).toBe(source)
  })

  it('keeps literal examples while excluding nested opposite-audience wrappers', () => {
    const source = 'Before.\n\n<Human>Secret humain.</Human>\n\n<Agent>机器 <Visibility for="humans">hidden</Visibility> visible</Agent>\n\n```mdx\n<Human>Literal example.</Human>\n```\n\n`<Visibility for="humans">`'
    const agents = projectMdxAudience(source, 'agents')
    expect(agents).not.toContain('Secret humain.')
    expect(agents).not.toContain('hidden')
    expect(agents).toContain('机器')
    expect(agents).toContain('<Human>Literal example.</Human>')
    expect(agents).toContain('`<Visibility for="humans">`')
    const humans = projectMdxAudience(source, 'humans')
    expect(humans).toContain('Secret humain.')
    expect(humans).not.toContain('机器')
    expect(projectMdxAudience(source, 'all')).toBe(source)
  })

  it('does not treat similarly named or differently cased components as visibility wrappers', () => {
    const source = '<Humanity>One.</Humanity>\n\n<AgentWidget>Two.</AgentWidget>\n\n<human>Three.</human>\n\n<Visibility for="unknown">Four.</Visibility>'
    expect(projectMdxAudience(source, 'agents')).toBe(source)
  })
})
