import { describe, expect, it } from 'vitest';
import { StateStore, initialSnapshot } from '../../src/services/state';

describe('StateStore', () => {
  it('starts with initial snapshot', () => {
    const store = new StateStore();
    expect(store.get()).toEqual(initialSnapshot());
    store.dispose();
  });

  it('merges bridge partials without dropping siblings', () => {
    const store = new StateStore();
    store.updateBridge({ status: 'running', port: 3845 });
    store.updateBridge({ sessionId: 'abc' });
    expect(store.get().bridge.status).toBe('running');
    expect(store.get().bridge.port).toBe(3845);
    expect(store.get().bridge.sessionId).toBe('abc');
    store.dispose();
  });

  it('notifies subscribers', () => {
    const store = new StateStore();
    let calls = 0;
    const off = store.onDidChange(() => {
      calls += 1;
    });
    store.updateRuntime({ healthy: true });
    expect(calls).toBe(1);
    off();
    store.updateRuntime({ healthy: false });
    expect(calls).toBe(1);
    store.dispose();
  });
});
