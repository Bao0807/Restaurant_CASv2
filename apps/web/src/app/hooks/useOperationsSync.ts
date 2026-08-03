import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchOperations, synchronizeServerClock } from '../services/api';
import type { OperationsSnapshot } from './useRestaurantStore';

interface UseOperationsSyncOptions {
  active: boolean;
  applyOperations: (operations: OperationsSnapshot) => void;
  onUnauthorized: () => void;
}

/** Điều phối polling định kỳ và phục hồi kết nối trong một nơi duy nhất. */
export function useOperationsSync({ active, applyOperations, onUnauthorized }: UseOperationsSyncOptions) {
  const [syncStatus, setSyncStatus] = useState<'online' | 'stale'>('online');
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const requestSequenceRef = useRef(0);
  const lastAppliedSequenceRef = useRef(0);
  const lastSnapshotRef = useRef<OperationsSnapshot | null>(null);

  const applySnapshot = useCallback((operations: OperationsSnapshot, sequence: number) => {
    if (sequence < lastAppliedSequenceRef.current) return false;
    lastAppliedSequenceRef.current = sequence;
    lastSnapshotRef.current = operations;
    synchronizeServerClock(operations.serverClockOffsetMs);
    applyOperations(operations);
    setSyncStatus('online');
    setLastSyncAt(new Date());
    return true;
  }, [applyOperations]);

  const refreshOperationsSnapshot = useCallback(async (shouldApply: () => boolean = () => true) => {
    const sequence = ++requestSequenceRef.current;
    try {
      const operations = await fetchOperations();
      if (!shouldApply()) return operations;
      return applySnapshot(operations, sequence)
        ? operations
        : (lastSnapshotRef.current ?? operations);
    } catch (error) {
      if (sequence < lastAppliedSequenceRef.current && lastSnapshotRef.current) {
        return lastSnapshotRef.current;
      }
      throw error;
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        await refreshOperationsSnapshot();
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 401) onUnauthorized();
        else if (!stopped) setSyncStatus('stale');
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active, onUnauthorized, refreshOperationsSnapshot]);

  useEffect(() => {
    if (!active) return;
    let refreshing = false;
    const refreshWhenAvailable = async () => {
      if (refreshing || document.visibilityState === 'hidden' || navigator.onLine === false) return;
      refreshing = true;
      try {
        await refreshOperationsSnapshot();
      } catch {
        setSyncStatus('stale');
      } finally {
        refreshing = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshWhenAvailable();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', refreshWhenAvailable);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', refreshWhenAvailable);
    };
  }, [active, refreshOperationsSnapshot]);

  return { operationsSyncStatus: syncStatus, lastOperationsSyncAt: lastSyncAt, refreshOperationsSnapshot };
}
