import { useEffect, useRef, useState } from "react";
import type { DocumentRecord } from "../../shared/contracts";
import { apiFetch } from "../api";
import type {
  EpubBridge,
  EpubReadyInfo,
  EpubRelocation,
  EpubSelection,
} from "../epub-bridge";
import { EpubBridgeClient } from "../epub-bridge-client";
import { toUiError, type UiError } from "../i18n";

interface EpubViewerFrameProps {
  sessionKey: number;
  document: DocumentRecord | null;
  title: string;
  onBridge: (bridge: EpubBridge | null) => void;
  onReady: (info: EpubReadyInfo) => void;
  onRelocated: (relocation: EpubRelocation) => void;
  onSelection: (selection: EpubSelection | null) => void;
  onError: (error: UiError) => void;
}

export function EpubViewerFrame({
  sessionKey,
  document,
  title,
  onBridge,
  onReady,
  onRelocated,
  onSelection,
  onError,
}: EpubViewerFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const clientRef = useRef<EpubBridgeClient | null>(null);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onBridge, onReady, onRelocated, onSelection, onError });
  callbacks.current = { onBridge, onReady, onRelocated, onSelection, onError };
  const documentId = document?.format === "epub" ? document.id : null;

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    const client = new EpubBridgeClient(frame, {
      onViewerReady: () => setLoaded(true),
      onReady: (info) => callbacks.current.onReady(info),
      onRelocated: (relocation) => callbacks.current.onRelocated(relocation),
      onSelection: (selection) => callbacks.current.onSelection(selection),
      onFatal: ({ code, message }) =>
        callbacks.current.onError({ code, detail: message }),
    });
    clientRef.current = client;
    callbacks.current.onBridge(client);
    return () => {
      clientRef.current = null;
      client.dispose();
      callbacks.current.onBridge(null);
    };
  }, []);

  useEffect(() => {
    if (!loaded || !documentId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(`/api/documents/${documentId}/file`, {
          signal: controller.signal,
        });
        const bytes = await response.arrayBuffer();
        if (!controller.signal.aborted) clientRef.current?.open(bytes);
      } catch (error) {
        if (!controller.signal.aborted) callbacks.current.onError(toUiError(error));
      }
    })();
    return () => controller.abort();
  }, [documentId, loaded, sessionKey]);

  return (
    <iframe
      ref={iframeRef}
      className="epub-frame"
      title={title}
      src="/typst/epub-viewer.html"
      sandbox="allow-scripts allow-same-origin"
      onLoad={() => clientRef.current?.hello()}
    />
  );
}
