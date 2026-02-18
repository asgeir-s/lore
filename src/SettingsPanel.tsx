import { useState, useEffect, useCallback } from "react";
import { listInputDevices } from "./api";
import type { ToolStatus, InputDeviceInfo } from "./api";

interface SettingsPanelProps {
  toolStatus: ToolStatus;
  recordingDevice: string | null;
  onDeviceChange: (device: string | null) => void;
  onRefreshTools: () => void;
  onClose: () => void;
}

const TOOLS = [
  { key: "git" as const, label: "git", description: "Version control & sync", command: "xcode-select --install" },
  { key: "ffmpeg" as const, label: "ffmpeg", description: "Audio processing", command: "brew install ffmpeg" },
  { key: "whisper" as const, label: "whisper-cli", description: "Speech transcription", command: "brew install whisper-cpp" },
  { key: "ollama" as const, label: "ollama", description: "AI tagging & summaries", command: "brew install ollama" },
  { key: "qmd" as const, label: "qmd", description: "Related notes search", command: "npm install -g @tobilu/qmd" },
];

export function SettingsPanel({
  toolStatus,
  recordingDevice,
  onDeviceChange,
  onRefreshTools,
  onClose,
}: SettingsPanelProps) {
  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);

  useEffect(() => {
    listInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  // Escape and click-outside to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      onDeviceChange(value === "" ? null : value);
    },
    [onDeviceChange],
  );

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-section">
          <div className="settings-section-title">Recording Device</div>
          <select
            className="settings-device-select"
            value={recordingDevice ?? ""}
            onChange={handleSelectChange}
          >
            <option value="">Auto-detect</option>
            {devices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}{d.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        {TOOLS.some((t) => !toolStatus[t.key]) && (
          <div className="settings-section">
            <div className="settings-section-title">
              Missing Tools
              <button className="settings-refresh-btn" onClick={onRefreshTools}>
                Refresh
              </button>
            </div>
            {TOOLS.filter((t) => !toolStatus[t.key]).map((tool) => (
              <div key={tool.key} className="settings-tool-row">
                <div className="settings-tool-info">
                  <span className="settings-tool-name">{tool.label}</span>
                  <span className="settings-tool-desc">{tool.description}</span>
                </div>
                <code className="settings-install-cmd">{tool.command}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
