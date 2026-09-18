import { createConnection } from 'node:net'

import type { IbkrGatewayStatus } from '../../shared/ipc'

const PORTS = [4002, 4001] as const

export function probeIbkrPort(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

export async function detectIbkrGateway(
  probe: (port: number) => Promise<boolean> = probeIbkrPort
): Promise<IbkrGatewayStatus> {
  const listening = await Promise.all(PORTS.map(async (port) => ({ port, listening: await probe(port) })))
  const found = listening.find((row) => row.listening)
  if (!found) {
    return {
      connected: false,
      message: 'Gateway API not available yet. Log in, enable ActiveX and Socket Clients, and keep Read-Only API on.'
    }
  }
  const mode = found.port === 4002 ? 'paper' : 'live'
  return {
    connected: true,
    port: found.port,
    mode,
    message: `Gateway API detected on localhost:${found.port} (${mode}). Read-only integration can connect.`
  }
}
