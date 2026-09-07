import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: {} }));

import { createEventDelivery, EVENT_ACK_CHANNEL } from '../src/main/eventDelivery.js';

describe('GUI event backpressure', () => {
  it('keeps one event in flight until the owning renderer acknowledges its exact sequence', async () => {
    const source = new EventEmitter();
    const contents = { send: vi.fn() };
    const delivery = createEventDelivery(contents, source);
    const completed = vi.fn();
    const first = delivery
      .send('rune:event', { kind: 'stepOutput', line: 'first' })
      .then(completed);
    expect(contents.send).toHaveBeenCalledWith('rune:event', {
      sequence: 1,
      event: { kind: 'stepOutput', line: 'first' },
    });
    source.emit(EVENT_ACK_CHANNEL, { sender: {} }, 1);
    source.emit(EVENT_ACK_CHANNEL, { sender: contents }, 2);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    await expect(delivery.send('rune:event', {})).rejects.toThrow('must be delivered serially');
    expect(contents.send).toHaveBeenCalledTimes(1);
    source.emit(EVENT_ACK_CHANNEL, { sender: contents }, 1);
    await first;
    expect(completed).toHaveBeenCalledOnce();
    const second = delivery.send('rune:event', { kind: 'runFinished' });
    expect(contents.send).toHaveBeenLastCalledWith('rune:event', {
      sequence: 2,
      event: { kind: 'runFinished' },
    });
    source.emit(EVENT_ACK_CHANNEL, { sender: contents }, 2);
    await second;
    delivery.dispose();
    expect(source.listenerCount(EVENT_ACK_CHANNEL)).toBe(0);
  });

  it('releases a pending event and stops sending after renderer loss or close', async () => {
    const source = new EventEmitter();
    const contents = { send: vi.fn() };
    const delivery = createEventDelivery(contents, source);
    const pending = delivery.send('rune:event', {});
    delivery.dispose();
    delivery.dispose();
    await pending;
    await delivery.send('rune:event', {});
    expect(contents.send).toHaveBeenCalledOnce();
    expect(source.listenerCount(EVENT_ACK_CHANNEL)).toBe(0);
  });

  it('clears an unsent event when Electron refuses delivery', async () => {
    const source = new EventEmitter();
    const failure = new Error('contents destroyed');
    const contents = {
      send: vi.fn().mockImplementationOnce(() => {
        throw failure;
      }),
    };
    const delivery = createEventDelivery(contents, source);
    await expect(delivery.send('rune:event', {})).rejects.toBe(failure);
    const pending = delivery.send('rune:event', {});
    source.emit(EVENT_ACK_CHANNEL, { sender: contents }, 2);
    await pending;
    delivery.dispose();
  });
});
