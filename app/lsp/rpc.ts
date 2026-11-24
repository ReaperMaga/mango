/**
 * JSON-RPC as a language server speaks it, over whatever carries one message at a time (the
 * backend adds and strips the framing). Every request settles: answered, cancelled, timed out,
 * or rejected when the connection closes.
 */

import { t } from '../i18n/index.ts'

const REQUEST_CANCELLED = -32800
const CONTENT_MODIFIED = -32801
const SERVER_CANCELLED = -32802
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
/** Not the protocol's: no answer in time, or no connection to answer on. */
export const TIMED_OUT = -1
export const CLOSED = -2

export class RpcError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** A request that came to nothing for a reason of no interest to the user: its answer is just empty. */
export const isBenign = (e: unknown) =>
  e instanceof RpcError && [REQUEST_CANCELLED, CONTENT_MODIFIED, SERVER_CANCELLED, TIMED_OUT, CLOSED].includes(e.code)

/** What a Monaco `CancellationToken` offers. */
export interface CancelToken {
  readonly isCancellationRequested: boolean
  onCancellationRequested(listener: () => void): { dispose(): void }
}

export interface RequestOptions { timeout?: number; token?: CancelToken }

export interface RpcHandlers {
  /** Answer a request of the server's; return `undefined` for a method that is not known. */
  request(method: string, params: any): unknown
  notification(method: string, params: any): void
}

interface Waiting { resolve(value: any): void; reject(error: RpcError): void }

export class Rpc {
  private send: (message: string) => void
  private handlers: RpcHandlers
  private seq = 0
  private waiting = new Map<number, Waiting>()
  private closed = false

  constructor(send: (message: string) => void, handlers: RpcHandlers) {
    this.send = send
    this.handlers = handlers
  }

  private write(message: object) {
    if (!this.closed) this.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }

  notify(method: string, params?: unknown) {
    this.write({ method, params })
  }

  request<T>(method: string, params?: unknown, { timeout = 10_000, token }: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(CLOSED, t('files.server.notRunning')))
    if (token?.isCancellationRequested) return Promise.reject(new RpcError(REQUEST_CANCELLED, 'Cancelled.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      let sub: { dispose(): void } | undefined
      const settle = () => {
        this.waiting.delete(id)
        clearTimeout(timer)
        sub?.dispose()
      }
      const abandon = (code: number, message: string) => {
        if (!this.waiting.has(id)) return
        settle()
        this.notify('$/cancelRequest', { id })
        reject(new RpcError(code, message))
      }
      const timer = setTimeout(() => abandon(TIMED_OUT, t('files.server.noAnswer', { method })), timeout)
      this.waiting.set(id, {
        resolve: (value) => { settle(); resolve(value) },
        reject: (error) => { settle(); reject(error) },
      })
      this.write({ id, method, params })
      sub = token?.onCancellationRequested(() => abandon(REQUEST_CANCELLED, 'Cancelled.'))
    })
  }

  receive(text: string) {
    if (this.closed) return
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const { id, method, params } = msg
    if (typeof method !== 'string') {
      // An answer. A late one (cancelled, timed out) has nobody waiting.
      const waiting = typeof id === 'number' ? this.waiting.get(id) : undefined
      if (!waiting) return
      if (msg.error) waiting.reject(new RpcError(Number(msg.error.code) || INTERNAL_ERROR, String(msg.error.message ?? t('files.server.requestFailed'))))
      else waiting.resolve(msg.result ?? null)
      return
    }
    if (id === undefined || id === null) {
      try {
        this.handlers.notification(method, params)
      } catch (e) {
        console.warn(`Language server notification ${method}:`, e)
      }
      return
    }
    try {
      const result = this.handlers.request(method, params)
      if (result === undefined) this.write({ id, error: { code: METHOD_NOT_FOUND, message: `Mango does not support ${method}.` } })
      else this.write({ id, result })
    } catch (e) {
      this.write({ id, error: { code: INTERNAL_ERROR, message: String(e) } })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiting of [...this.waiting.values()]) waiting.reject(new RpcError(CLOSED, t('files.server.ended')))
  }
}
