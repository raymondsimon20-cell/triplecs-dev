'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

export interface StreamCredentials {
  streamerSocketUrl:      string;
  schwabClientCustomerId: string;
  schwabClientCorrelId:   string;
  schwabClientChannel:    string;
  schwabClientFunctionId: string;
  accessToken:            string;
}

export type LiveQuotes = Map<string, number>; // symbol → last price

type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UsePortfolioStreamResult {
  liveQuotes: LiveQuotes;
  status:     StreamStatus;
  reconnect:  () => void;
}

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECTS     = 5;

export function usePortfolioStream(
  symbols: string[],
  enabled = true,
): UsePortfolioStreamResult {
  const wsRef        = useRef<WebSocket | null>(null);
  const credsRef     = useRef<StreamCredentials | null>(null);
  const reconnectRef = useRef(0);
  const symbolsRef   = useRef(symbols);
  symbolsRef.current = symbols;

  const [liveQuotes, setLiveQuotes] = useState<LiveQuotes>(new Map());
  const [status,     setStatus]     = useState<StreamStatus>('disconnected');

  const sendJSON = (ws: WebSocket, data: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  };

  const subscribe = useCallback((ws: WebSocket, creds: StreamCredentials, syms: string[]) => {
    if (!syms.length) return;
    sendJSON(ws, {
      requests: [{
        service:                'LEVELONE_EQUITIES',
        requestid:              '2',
        command:                'SUBS',
        SchwabClientCustomerId: creds.schwabClientCustomerId,
        SchwabClientCorrelId:   creds.schwabClientCorrelId,
        parameters: {
          keys:   syms.join(','),
          fields: '0,1,2,3,4,8', // 0=symbol,1=bid,2=ask,3=last,4=bidSize,8=totalVolume
        },
      }],
    });
  }, []);

  const connect = useCallback(async () => {
    if (!enabled || !symbolsRef.current.length) return;

    setStatus('connecting');

    try {
      // Fetch credentials if not cached
      if (!credsRef.current) {
        const res = await fetch('/api/stream-credentials');
        if (!res.ok) throw new Error('Could not fetch stream credentials');
        credsRef.current = await res.json();
      }

      const creds = credsRef.current!;
      const wsUrl = creds.streamerSocketUrl.startsWith('wss://')
        ? creds.streamerSocketUrl
        : `wss://${creds.streamerSocketUrl}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        // Send login
        sendJSON(ws, {
          requests: [{
            service:                'ADMIN',
            requestid:              '0',
            command:                'LOGIN',
            SchwabClientCustomerId: creds.schwabClientCustomerId,
            SchwabClientCorrelId:   creds.schwabClientCorrelId,
            parameters: {
              Authorization:          creds.accessToken,
              SchwabClientChannel:    creds.schwabClientChannel,
              SchwabClientFunctionId: creds.schwabClientFunctionId,
            },
          }],
        });
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string);

          // Login response — subscribe after successful login
          if (msg?.response?.[0]?.command === 'LOGIN') {
            const code = msg.response[0]?.content?.code;
            if (code === 0 || code === '0') {
              setStatus('connected');
              subscribe(ws, creds, symbolsRef.current);
            }
            return;
          }

          // Data updates
          const dataChunks = msg?.data ?? [];
          if (!dataChunks.length) return;

          setLiveQuotes((prev) => {
            const next = new Map(prev);
            for (const chunk of dataChunks) {
              if (chunk?.service !== 'LEVELONE_EQUITIES') continue;
              for (const item of (chunk.content ?? [])) {
                const symbol = item?.key ?? item?.['0'];
                const last   = item?.['3'] ?? item?.lastPrice;
                if (symbol && typeof last === 'number') {
                  next.set(symbol, last);
                }
              }
            }
            return next;
          });
        } catch { /* malformed message — ignore */ }
      };

      ws.onerror = () => {
        setStatus('error');
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!enabled) return;
        setStatus('disconnected');
        if (reconnectRef.current < MAX_RECONNECTS) {
          reconnectRef.current += 1;
          setTimeout(() => connect(), RECONNECT_DELAY_MS);
        }
      };
    } catch {
      setStatus('error');
    }
  }, [enabled, subscribe]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, connect]);

  // Re-subscribe when symbol list changes while connected
  useEffect(() => {
    if (status === 'connected' && wsRef.current && credsRef.current) {
      subscribe(wsRef.current, credsRef.current, symbols);
    }
  }, [symbols, status, subscribe]);

  return {
    liveQuotes,
    status,
    reconnect: () => {
      credsRef.current   = null;
      reconnectRef.current = 0;
      wsRef.current?.close();
      connect();
    },
  };
}
