// packages/shared/src/lib/event-transport.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { createEventTransport } from './event-transport';
import { QueryClient } from '@tanstack/react-query';
import { setPlatformBridge } from './bridge';

describe('EventTransport', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    setPlatformBridge({
      getDaemonStatus: async () => ({ running: true, port: 3001 }),
      startDaemon: async () => {},
      stopDaemon: async () => {},
      getApiBaseUrl: () => 'http://test:3001',
      subscribeApiBaseUrl: () => () => {},
    });
  });

  it('should create transport with connect method', () => {
    const transport = createEventTransport(queryClient);
    expect(typeof transport.connect).toBe('function');
  });

  it('should return cleanup function from connect', () => {
    const transport = createEventTransport(queryClient);
    const cleanup = transport.connect();
    expect(typeof cleanup).toBe('function');
  });
});
