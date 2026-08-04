import axios, { type AxiosRequestConfig } from 'axios'

const API_SUCCESS_CODE = 0

const API_URL =
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_OPENWORK_API_BASE_URL ||
  'http://127.0.0.1:3100'

interface ApiEnvelope<T> {
  code: number
  message: string
  data: T | null
}

function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    typeof value.code === 'number' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'data' in value
  )
}

export type RequestFailure =
  | {
      ok: false
      kind: 'network'
    }
  | {
      ok: false
      kind: 'business'
      code: number
      message: string
    }

export type RequestResult<T> =
  | {
      ok: true
      data: T
    }
  | RequestFailure

const client = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
})

/**
 * 将失败结果转为可展示的错误文案。
 *
 * @param result - ``ok: false`` 的请求结果
 * @returns 面向用户的错误描述
 */
export function getRequestErrorMessage(result: RequestFailure): string {
  if (result.kind === 'business') {
    return result.message
  }

  return '网络异常，请稍后重试'
}

type RequestConfig = AxiosRequestConfig

/**
 * 发起 API 请求并解包统一 envelope 响应。
 *
 * @typeParam T - 业务 data 类型
 * @param config - axios 请求配置
 * @returns 解包后的请求结果
 */
export function request<T>(config: RequestConfig): Promise<RequestResult<T>> {
  return client
    .request(config)
    .then((response): RequestResult<T> => {
      if (!isApiEnvelope(response.data)) {
        console.error('请求出错了，接口返回数据不符合结构', response.data)
        return { ok: false, kind: 'network' }
      }

      const envelope = response.data as ApiEnvelope<T>

      if (response.status === 200 && envelope.code === API_SUCCESS_CODE) {
        return { ok: true, data: envelope.data as T }
      }

      if (response.status === 200) {
        return {
          ok: false,
          kind: 'business',
          code: envelope.code,
          message: envelope.message
        }
      }

      return { ok: false, kind: 'network' }
    })
    .catch((error) => {
      console.error('请求出错了', error)
      return { ok: false, kind: 'network' }
    })
}
