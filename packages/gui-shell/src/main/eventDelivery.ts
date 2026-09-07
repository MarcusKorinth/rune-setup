import { ipcMain, type WebContents } from 'electron';

import { InternalError } from '@rune/engine';

export const EVENT_ACK_CHANNEL = 'rune:eventAck';

export interface EventAckSource {
  on(channel: string, listener: (event: { sender: unknown }, sequence: unknown) => void): unknown;
  off(channel: string, listener: (event: { sender: unknown }, sequence: unknown) => void): unknown;
}

/** One in-flight event; the serial engine observer supplies the producer backpressure. */
export function createEventDelivery(
  contents: Pick<WebContents, 'send'>,
  acknowledgements: EventAckSource = ipcMain,
): {
  send(channel: string, event: unknown): Promise<void>;
  dispose(): void;
} {
  let sequence = 0;
  let disposed = false;
  let pending: { sequence: number; resolve: () => void } | undefined;
  const acknowledge = (event: { sender: unknown }, acknowledged: unknown): void => {
    if (event.sender !== contents || pending === undefined || acknowledged !== pending.sequence) {
      return;
    }
    const delivered = pending;
    pending = undefined;
    delivered.resolve();
  };
  acknowledgements.on(EVENT_ACK_CHANNEL, acknowledge);

  return {
    send: (channel, event) => {
      if (disposed) return Promise.resolve();
      if (pending !== undefined) {
        return Promise.reject(new InternalError('GUI run events must be delivered serially'));
      }
      sequence += 1;
      return new Promise<void>((resolve, reject) => {
        pending = { sequence, resolve };
        try {
          contents.send(channel, { sequence, event });
        } catch (error) {
          pending = undefined;
          reject(error);
        }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      acknowledgements.off(EVENT_ACK_CHANNEL, acknowledge);
      const abandoned = pending;
      pending = undefined;
      abandoned?.resolve();
    },
  };
}
