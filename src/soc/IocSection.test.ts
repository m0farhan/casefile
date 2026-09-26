import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../test/fakeDom'
import { makeTask, type Ioc } from '../types'
import { renderIocSection } from './IocSection'

const { notices, requests } = vi.hoisted(() => ({
  notices: [] as string[],
  requests: [] as { url: string }[]
}))
const responses: { status: number; text: string }[] = []

vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    Notice: class {
      constructor(message: string) {
        notices.push(message)
      }
      hide(): void {}
    },
    requestUrl: (req: { url: string }) => {
      requests.push(req)
      return Promise.resolve(responses.shift() ?? { status: 500, text: '' })
    },
    // IconButton's component: the tooltip is kept as the label to find it by.
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(text: string): this {
        this.extraSettingsEl.setAttr('aria-label', text)
        return this
      }
    }
  }
})

function mount(iocs: Ioc[], findSightings?: () => (value: string) => { key: string; title: string }[]) {
  const root = FakeEl.root()
  renderIocSection(root as unknown as HTMLElement, makeTask({ iocs }), {
    onChange: () => {},
    reputationKeys: { abuseipdb: 'key' },
    ownedAssets: () => [],
    findSightings
  })
  const buttons = (label: string) => root.descendants().filter((el) => el.getAttribute('aria-label') === label)
  return { root, buttons }
}

beforeEach(() => {
  notices.length = 0
  requests.length = 0
  responses.length = 0
})

describe('renderIocSection', () => {
  it('builds the sightings lookup once per render, not once per row', () => {
    const lookup = vi.fn<(value: string) => { key: string; title: string }[]>((v) =>
      v === '8.8.8.8' ? [{ key: 'SOC-2', title: 'Earlier case' }] : []
    )
    const factory = vi.fn<() => typeof lookup>(() => lookup)
    const { root } = mount(
      [
        { type: 'ip', value: '8.8.8.8' },
        { type: 'ip', value: '1.1.1.1' },
        { type: 'domain', value: 'evil.example' }
      ],
      factory
    )
    expect(factory).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(root.findAll('.pm-ioc-sightings').map((el) => el.textContent)).toEqual(['Also in SOC-2'])
  })

  it('Check all asks again for a row whose lookup was rate-limited, and not for a settled one', async () => {
    const { root, buttons } = mount([{ type: 'ip', value: '8.8.8.8' }])
    responses.push({ status: 429, text: '' })
    buttons('Check reputation')[0].click()
    await vi.waitFor(() => expect(root.find('.pm-ioc-rep-chip').textContent).toContain('rate limited'))

    responses.push({ status: 401, text: '' })
    buttons('Check all indicators')[0].click()
    await vi.waitFor(() => expect(notices).toEqual(['Checked 1 indicator']))
    expect(requests).toHaveLength(2)

    // 'key rejected' is an answer, not a failure: nothing is sent a third time.
    buttons('Check all indicators')[0].click()
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices[1]).toBe('Checked 0 indicators · 1 already checked')
    expect(requests).toHaveLength(2)
  })

  it('a value no provider could look up says so, with keys set, and sends nothing', async () => {
    const { buttons } = mount([{ type: 'domain', value: 'C:\\Users\\jdoe' }])
    buttons('Check reputation')[0].click()
    expect(notices).toEqual(['Not an address, host or hash a provider can look up — nothing sent'])
    buttons('Check all indicators')[0].click()
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices[1]).toBe('Checked 0 indicators · 1 not an address, host or hash — nothing sent')
    expect(requests).toHaveLength(0)
  })
})
