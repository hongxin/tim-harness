/**
 * 微信小程序装配根：注入 wx 四件适配器，core 原样运行。
 * 使用方（真实小程序页面）：import { bootWechatHarness } from '.../platform/wechat/boot'
 */
import { HarnessRuntime } from '../../core/runtime'
import { createWxKV, createWxFS, createWxSandbox, createWxTransport } from './adapters'
import type { WxLike } from './wx-types'

export async function bootWechatHarness(wx: WxLike): Promise<HarnessRuntime> {
  const runtime = new HarnessRuntime({
    kv: createWxKV(wx),
    fs: createWxFS(wx),
    transport: createWxTransport(wx),
    sandbox: createWxSandbox(),
  })
  await runtime.boot()
  return runtime
}
