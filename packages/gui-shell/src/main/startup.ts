import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { InternalError } from '@rune/engine';

export const STARTUP_TOKEN_ENV = 'RUNE_GUI_STARTUP_TOKEN';
const STARTUP_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 128;

export type StartupDecision = 'start' | 'cancel';
export type StartupGate = () => Promise<StartupDecision>;

/** Consume launcher-only state before the engine can snapshot or inherit its environment. */
export function takeStartupGate(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): StartupGate | undefined {
  const token = environment[STARTUP_TOKEN_ENV];
  delete environment[STARTUP_TOKEN_ENV];
  if (token === undefined || platform !== 'linux') return undefined;

  return () => {
    if (!/^[a-f0-9]{32}$/.test(token)) {
      return Promise.reject(new InternalError('the GUI shell startup token is invalid'));
    }
    let channel: Socket;
    try {
      channel = new Socket({ fd: 3, readable: true, writable: true });
    } catch (cause) {
      return Promise.reject(
        new InternalError('the GUI shell startup channel could not be opened', { cause }),
      );
    }
    return waitForStartupDecision(channel, token);
  };
}

/** The shell cannot open a Session until its launcher transfers ownership on this channel. */
export function waitForStartupDecision(channel: Duplex, token: string): Promise<StartupDecision> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let input = '';
    let bytes = 0;
    const finish = (decision: StartupDecision | InternalError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      channel.removeListener('data', onData);
      channel.removeListener('end', onEnd);
      channel.removeListener('close', onEnd);
      // Keep the error owner through destroy's asynchronous close and any pending write.
      if (channel.closed) channel.removeListener('error', onError);
      else channel.once('close', () => channel.removeListener('error', onError));
      channel.destroy();
      if (decision instanceof InternalError) reject(decision);
      else resolve(decision);
    };
    const fail = (): void => {
      finish(new InternalError('the GUI shell startup handshake failed'));
    };
    const onError = (): void => fail();
    const onEnd = (): void => fail();
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      input += chunk.toString('utf8');
      if (!input.includes('\n')) return;
      if (input === `START ${token}\n`) finish('start');
      else if (input === `CANCEL ${token}\n`) finish('cancel');
      else fail();
    };
    const deadline = setTimeout(() => {
      finish(new InternalError('the GUI shell startup decision did not arrive within 10 seconds'));
    }, STARTUP_TIMEOUT_MS);
    channel.on('error', onError);
    channel.on('data', onData);
    channel.once('end', onEnd);
    channel.once('close', onEnd);
    try {
      channel.write(`READY ${token}\n`, (error) => {
        if (error !== null && error !== undefined) fail();
      });
    } catch {
      fail();
    }
  });
}
