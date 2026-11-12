import { useCallback, useEffect, useRef, useState } from "react";
import { checkRecordingPermissions, openRecordingPrivacySettings, requestRecordingPermission } from "./api";
import type { RecordingPermissionKind, RecordingPermissionStatus, RecordingPermissionsStatus } from "./api";

const labels: Record<RecordingPermissionStatus, string> = {
  granted: "Allowed",
  denied: "Not allowed",
  restricted: "Restricted by this Mac",
  unknown: "Access needed",
  unavailable: "Couldn’t verify access",
  not_required: "Not required",
};

interface NoticeProps {
  permissions: RecordingPermissionsStatus | null;
  checking: boolean;
  pending: RecordingPermissionKind | null;
  error: string | null;
  onRefresh: () => void;
  onRequest: (kind: RecordingPermissionKind) => void;
  onSettings: (kind: RecordingPermissionKind) => void;
  onDismiss: () => void;
}

export function RecordingPermissionsNotice({ permissions, checking, pending, error, onRefresh, onRequest, onSettings, onDismiss }: NoticeProps) {
  const ready = permissions?.microphone === "granted" && permissions.system_audio === "granted";
  return (
    <section className="recording-permissions" aria-label="Recording access" aria-busy={checking}>
      <div className="recording-permissions-heading">
        <p role="status">{ready ? "Ready to record" : checking && !permissions ? "Checking recording access…" : "Recording access needs attention"}</p>
        <div className="recording-permissions-actions">
          <button onClick={onRefresh} disabled={checking || pending !== null}>{checking ? "Checking…" : "Check again"}</button>
          {ready && <button onClick={onDismiss}>Dismiss</button>}
        </div>
      </div>
      {error && <p className="recording-permissions-error" role="alert">{error}</p>}
      {ready ? <p className="recording-permissions-description">Microphone and system audio access allowed.</p> : permissions && (
        <>
          <p className="recording-permissions-description">Allow access before your next meeting. Checking does not record audio.</p>
          {(["microphone", "system_audio"] as const).map((kind) => {
            const status = permissions[kind];
            const name = kind === "microphone" ? "Microphone" : "System audio";
            return (
              <div className="recording-permission-row" key={kind}>
                <span className="recording-permission-label">{name}</span>
                <span>{labels[status]}</span>
                {status !== "granted" && status !== "not_required" && (
                  <button disabled={pending !== null} aria-label={`${status === "unknown" ? "Allow" : "Open settings for"} ${name.toLowerCase()}`} onClick={() => status === "unknown" ? onRequest(kind) : onSettings(kind)}>
                    {pending === kind ? "Opening…" : status === "unknown" ? "Allow access" : "Open Settings"}
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

export function RecordingPermissions() {
  const [permissions, setPermissions] = useState<RecordingPermissionsStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RecordingPermissionKind | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const requestId = useRef(0);
  const ready = permissions?.microphone === "granted" && permissions.system_audio === "granted";

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setChecking(true);
    try {
      const status = await checkRecordingPermissions();
      if (id !== requestId.current) return;
      setPermissions(status);
      setError(null);
    } catch {
      if (id !== requestId.current) return;
      setPermissions(null);
      setError("Could not check recording access. Check again before starting a meeting recording.");
    } finally {
      if (id === requestId.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { ++requestId.current; window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  useEffect(() => {
    if (!permissions?.supported || ready) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [permissions?.supported, ready, refresh]);

  const act = async (kind: RecordingPermissionKind, settings: boolean) => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      if (settings) await openRecordingPrivacySettings(kind);
      else await requestRecordingPermission(kind);
      await refresh();
    } catch {
      setError("Could not open the permission request. Allow Lore in System Settings → Privacy & Security, then check again.");
    } finally { setPending(null); }
  };

  if ((!permissions?.supported && !error) || (ready && dismissed)) return null;
  return <RecordingPermissionsNotice permissions={permissions} checking={checking} pending={pending} error={error} onRefresh={() => { void refresh(); }} onRequest={(kind) => { void act(kind, false); }} onSettings={(kind) => { void act(kind, true); }} onDismiss={() => setDismissed(true)} />;
}
