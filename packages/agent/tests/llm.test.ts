/**
 * @file llm.ts 单元测试
 */

import { defaultSettings } from '@luneto/shared'
import { describe, expect, it, vi } from 'vitest'
import { getChatModel } from '../src/llm.js'

describe('getChatModel', () => {
  it('未配置 API Key 时返回 null', () => {
    expect(getChatModel(defaultSettings)).toBeNull()
  })
})
